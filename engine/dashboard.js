// Adds the numbers the dashboard draws to the engine's state: summary, daily
// totals and per-habit 7-day figures. Computed from the raw logs, so it does not
// depend on how buildState works inside. Pure functions: no database, no AI.
const { normText, BUILD_TYPE } = require("./engine.js");

// "build" is what older saves wrote for build time; the engine calls it "continue".
const BUILD_TYPES = new Set([BUILD_TYPE || "continue", "build"]);
const DAY = 86400000;

function dayOf(ms, tz) {
  return new Date(ms + tz * 60000).toISOString().slice(0, 10);
}

function enrichState({
  state,
  logs,
  targets,
  dailyGoalMin,
  nowMs,
  tzOffsetMin,
}) {
  const tz = tzOffsetMin || 0;
  const goal =
    Number.isInteger(dailyGoalMin) && dailyGoalMin > 0 ? dailyGoalMin : 180;

  // 14 local days, oldest first. Index 13 is today; 7..13 are the last 7 days.
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayOf(nowMs - i * DAY, tz));
  const at = new Map(days.map((d, i) => [d, i]));
  const daily = days.map((day) => ({ day, build: 0, stop: 0 }));
  const per = { build: {}, stop: {} };
  let first = Infinity;

  for (const l of logs || []) {
    const ms = Date.parse(l.created_at);
    if (!Number.isFinite(ms)) continue;
    first = Math.min(first, ms);
    const i = at.get(dayOf(ms, tz));
    const min = Number(l.duration) || 0;
    const dir =
      l.habit_type === "stop"
        ? "stop"
        : BUILD_TYPES.has(l.habit_type)
          ? "build"
          : null;
    if (i === undefined || !dir || min <= 0) continue;
    daily[i][dir] += min;
    if (i >= 7) {
      const key = normText(l.subject);
      const rec = (per[dir][key] = per[dir][key] || {
        min: 0,
        days: new Set(),
      });
      rec.min += min;
      rec.days.add(i);
    }
  }

  const sum = (from, to, k) =>
    daily.slice(from, to).reduce((s, d) => s + d[k], 0);
  const last7Build = sum(7, 14, "build");
  const last7Stop = sum(7, 14, "stop");

  // Judge pace over the days actually tracked (1 to 7), so day one isn't "off track".
  const spanDays = Number.isFinite(first)
    ? Math.min(
        7,
        Math.max(
          1,
          Math.round(
            (Date.parse(days[13]) - Date.parse(dayOf(first, tz))) / DAY,
          ) + 1,
        ),
      )
    : 1;
  const perDay = last7Build / spanDays;
  const ratio = perDay / goal;

  state.summary = {
    dailyGoalMin: goal,
    todayBuild: daily[13].build,
    last7Build,
    prev7Build: sum(0, 7, "build"),
    avgBuildPerDay: Math.round(perDay),
    focusScore:
      last7Build + last7Stop > 0
        ? Math.round((last7Build / (last7Build + last7Stop)) * 100)
        : null,
    paceStatus:
      ratio >= 1
        ? "met"
        : ratio >= 0.8
          ? "on_track"
          : ratio >= 0.5
            ? "adjust"
            : "off_track",
  };
  state.daily = daily;

  for (const h of state.habits || []) {
    const rec = (per[h.direction] || {})[h.subject];
    h.minutes7d = rec ? rec.min : 0;
    h.days7d = rec ? rec.days.size : 0;
    h.last7Days = [7, 8, 9, 10, 11, 12, 13].map((i) =>
      Boolean(rec && rec.days.has(i)),
    );
    const t = targets && targets[h.subject];
    h.targetDaysPerWeek =
      t && Number.isInteger(t.daysPerWeek) ? t.daysPerWeek : null;
    if (h.status === undefined) h.status = null;
  }

  // The dashboard reads overall.buildStreakDays; fall back to counting it here.
  state.overall = state.overall || {};
  if (typeof state.overall.buildStreakDays !== "number") {
    let i = daily[13].build > 0 ? 13 : 12;
    let n = 0;
    for (; i >= 0 && daily[i].build > 0; i--) n++;
    state.overall.buildStreakDays = n;
  }
  return state;
}

module.exports = { enrichState };
