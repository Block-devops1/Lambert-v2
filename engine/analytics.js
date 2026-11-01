// Everything the Analytics page shows is computed here: no database, no AI.
// It reuses the engine's own rules (cleanLogs, dayKey, mondayOf, streakFor) and
// reads habit strength, weekly scores, this week's status and per-habit streaks
// from the engine's state (buildState), so a number can never differ between
// this page, the dashboard and the coach.
const E = require("./engine.js");
const { cleanLogs, dayKey, shiftDay, mondayOf, streakFor } = E;

const DAY = 86400000;
const REASONS = {
  tired: "Tired",
  busy: "Busy",
  forgot: "Forgot",
  no_motivation: "No motivation",
  emergency: "Emergency",
  other: "Other",
};
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const keyMs = (k) => Date.parse(k + "T00:00:00Z");
const diff = (a, b) => Math.round((keyMs(b) - keyMs(a)) / DAY);
const dow = (k) => new Date(keyMs(k)).getUTCDay(); // 0 = Sunday
const hhmm = (ts, tz) =>
  new Date(ts + (tz || 0) * 60000).toISOString().slice(11, 16);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const reasonLabel = (r) =>
  !r ? "No reason given" : REASONS[r] || cap(String(r).replace(/_/g, " "));
const pct = (a, b) => Math.round(((a - b) / b) * 100);

// The engine's cleaned rows, plus the newest spelling the user gave each habit.
function prepare(logs, tz) {
  const rows = cleanLogs(logs, { tzOffsetMin: tz });
  const labels = {};
  rows
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .forEach((r) => {
      labels[r.subject] = r.label;
    });
  return { rows, labels };
}

function buildAnalytics({
  logs,
  today,
  nowMs,
  tzOffsetMin = 0,
  range = 30,
  goal = 180,
  targets = {},
  joined,
  truncated = false,
}) {
  const { rows, labels } = prepare(logs, tzOffsetMin);
  const tg = E.sanitizeTargets(targets);
  // The engine's state: the one source for strength, weekly scores, status and per-habit streaks.
  const state = E.buildState({
    logs,
    targets: tg,
    today,
    nowMs: nowMs || Date.parse(today + "T12:00:00Z") - tzOffsetMin * 60000,
    tzOffsetMin,
    dailyGoalMin: goal,
    localHour: 12,
  });
  const stateHab = {};
  state.habits.forEach((h) => {
    stateHab[h.subject] = h;
  });
  const start = shiftDay(today, -(range - 1));
  const joinedDay = joined && joined <= today ? joined : today;
  const effStart = start < joinedDay ? joinedDay : start;
  const spanDays = diff(effStart, today) + 1;
  const inRange = (r) => r.day >= start && r.day <= today;

  const perDay = {};
  rows.forEach((r) => {
    if (r.minutes > 0)
      (perDay[r.day] = perDay[r.day] || { build: 0, stop: 0 })[r.direction] +=
        r.minutes;
  });
  const sum = (from, to, k) => {
    let t = 0;
    for (let d = from; d <= to; d = shiftDay(d, 1))
      t += (perDay[d] || {})[k] || 0;
    return t;
  };

  // The period, and the same-length period before it (only when it fully exists).
  const build = sum(start, today, "build");
  const stop = sum(start, today, "stop");
  let activeDays = 0,
    goalDays = 0;
  for (let d = effStart; d <= today; d = shiftDay(d, 1)) {
    const b = (perDay[d] || {}).build || 0;
    if (b > 0) activeDays++;
    if (b >= goal) goalDays++;
  }
  const prevStart = shiftDay(today, -(2 * range - 1));
  const prevEnd = shiftDay(today, -range);
  const comparable = prevStart >= joinedDay;
  const prevBuild = comparable ? sum(prevStart, prevEnd, "build") : null;
  const period = {
    build,
    stop,
    activeDays,
    goalDays,
    spanDays,
    prevBuild,
    deltaPct: comparable && prevBuild > 0 ? pct(build, prevBuild) : null,
    focusScore:
      build + stop > 0 ? Math.round((build / (build + stop)) * 100) : null,
  };

  // Overall streak: best is always kept; the page never shows a bare zero.
  const allBuildDays = new Set(
    Object.keys(perDay).filter((d) => perDay[d].build > 0),
  );
  const streak = streakFor(allBuildDays, today);

  // Trend: daily bars for a week, weekly bars for longer ranges.
  const unit = range <= 7 ? "day" : "week";
  const points = [];
  if (unit === "day") {
    for (let d = start; d <= today; d = shiftDay(d, 1))
      points.push({
        label: SHORT[dow(d)],
        build: sum(d, d, "build"),
        stop: sum(d, d, "stop"),
        goalMin: d >= joinedDay ? goal : 0,
      });
  } else {
    for (let w = mondayOf(start); w <= today; w = shiftDay(w, 7)) {
      const from = w < start ? start : w;
      const end = shiftDay(w, 6);
      const to = end > today ? today : end;
      const counted = Math.max(
        0,
        diff(from < joinedDay ? joinedDay : from, to) + 1,
      );
      points.push({
        label: +w.slice(8) + " " + MON[+w.slice(5, 7) - 1],
        build: sum(from, to, "build"),
        stop: sum(from, to, "stop"),
        goalMin: goal * counted,
      });
    }
  }

  // Habits: this range's totals are computed here; strength, weekly scores, this
  // week's status and streaks come straight from the engine's state.
  const hab = {};
  rows
    .filter((r) => r.direction === "build" && r.minutes > 0 && inRange(r))
    .forEach((r) => {
      const h = (hab[r.subject] = hab[r.subject] || {
        minutes: 0,
        sessions: 0,
        days: new Set(),
      });
      h.minutes += r.minutes;
      h.sessions++;
      h.days.add(r.day);
    });
  Object.keys(tg).forEach((k) => {
    if (!hab[k]) hab[k] = { minutes: 0, sessions: 0, days: new Set() };
  });
  const habits = Object.keys(hab)
    .map((key) => {
      const info = hab[key],
        sh = stateHab[key] || {};
      const target = sh.targetDaysPerWeek || null;
      const st = sh.strength,
        wk = sh.weekly;
      return {
        subject: key,
        label: labels[key] || sh.label || key,
        minutes: info.minutes,
        sessions: info.sessions,
        avgSession: info.sessions
          ? Math.round(info.minutes / info.sessions)
          : 0,
        activeDays: info.days.size,
        spanDays,
        targetDaysPerWeek: target,
        strength: st ? Math.round(st.value * 100) : null,
        strengthDelta: st ? Math.round((st.value - st.previous) * 100) : null,
        weekly: wk
          ? {
              scores: wk.scores,
              weeksMet: wk.weeksTargetMet,
              fullWeeks: wk.fullWeeks,
            }
          : null,
        comebacks: wk ? wk.comebacks : 0,
        thisWeek: target
          ? { daysDone: sh.daysThisWeek, target, status: sh.status }
          : null,
        streak: sh.streak || { current: 0, longest: 0 },
      };
    })
    .sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));

  // Disruptors: ranked, with trend, share of the total, and days since last logged.
  const stopRows = rows.filter((r) => r.direction === "stop");
  const stopLast = {};
  stopRows.forEach((r) => {
    if (!stopLast[r.subject] || r.day > stopLast[r.subject])
      stopLast[r.subject] = r.day;
  });
  const dis = {};
  stopRows.filter(inRange).forEach((r) => {
    const d = (dis[r.subject] = dis[r.subject] || {
      label: labels[r.subject],
      minutes: 0,
      count: 0,
      prev: 0,
    });
    d.minutes += r.minutes;
    d.count++;
  });
  if (comparable)
    stopRows
      .filter((r) => r.day >= prevStart && r.day <= prevEnd)
      .forEach((r) => {
        if (dis[r.subject]) dis[r.subject].prev += r.minutes;
      });
  const ranked = Object.keys(dis)
    .map((k) => dis[k] && Object.assign({ subject: k }, dis[k]))
    .sort((a, b) => b.minutes - a.minutes);
  const disruptors = ranked.slice(0, 5).map((d) => ({
    label: d.label,
    minutes: d.minutes,
    count: d.count,
    share: stop ? Math.round((d.minutes / stop) * 100) : 0,
    deltaPct: comparable && d.prev >= 30 ? pct(d.minutes, d.prev) : null,
    daysSince: diff(stopLast[d.subject], today),
  }));
  if (ranked.length > 5) {
    const rest = ranked.slice(5);
    disruptors.push({
      label: "Other",
      minutes: rest.reduce((s, d) => s + d.minutes, 0),
      count: rest.reduce((s, d) => s + d.count, 0),
      other: true,
      share: 0,
      deltaPct: null,
      daysSince: null,
    });
    disruptors[5].share = stop
      ? Math.round((disruptors[5].minutes / stop) * 100)
      : 0;
  }

  // Misses: a build habit logged with 0 minutes is a recorded miss, with its reason.
  const missRows = rows.filter(
    (r) => r.direction === "build" && r.minutes === 0 && inRange(r),
  );
  const byReasonMap = {};
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  missRows.forEach((r) => {
    const k = r.reason || "none";
    byReasonMap[k] = (byReasonMap[k] || 0) + 1;
    byWeekday[dow(r.day)]++;
  });
  const misses = {
    total: missRows.length,
    byReason: Object.keys(byReasonMap)
      .map((k) => ({
        reason: k,
        label: reasonLabel(k === "none" ? null : k),
        count: byReasonMap[k],
      }))
      .sort((a, b) => b.count - a.count),
    byWeekday,
  };

  // Average build minutes by weekday: shows the weakest day even with no recorded misses.
  const tot = [0, 0, 0, 0, 0, 0, 0],
    cnt = [0, 0, 0, 0, 0, 0, 0];
  for (let d = effStart; d <= today; d = shiftDay(d, 1)) {
    tot[dow(d)] += (perDay[d] || {}).build || 0;
    cnt[dow(d)]++;
  }
  const avg = tot.map((t, i) => (cnt[i] ? Math.round(t / cnt[i]) : null));
  let weakest = null,
    strongest = null;
  if (spanDays >= 14) {
    avg.forEach((v, i) => {
      if (cnt[i] < 2) return;
      if (weakest === null || v < avg[weakest]) weakest = i;
      if (strongest === null || v > avg[strongest]) strongest = i;
    });
  }
  const weekday = { avg, weakest, strongest };

  const result = {
    range,
    goal,
    today,
    joined: joinedDay,
    truncated: !!truncated,
    period,
    streak,
    series: { unit, points },
    habits,
    disruptors,
    misses,
    weekday,
  };
  result.insights = insights(result, rows, labels, { today, joinedDay });
  result.headline = headline(range, period, misses);
  return result;
}

// Up to three plain sentences, each built from numbers already computed above.
function insights(a, rows, labels, { today, joinedDay }) {
  const out = [];
  // 1. a habit moving a lot: this rolling week against the one before
  const r7 = shiftDay(today, -6),
    p7 = shiftDay(today, -13),
    p7End = shiftDay(today, -7);
  if (p7 >= joinedDay) {
    const cur = {},
      prev = {};
    rows.forEach((r) => {
      if (r.direction !== "build" || r.minutes <= 0) return;
      if (r.day >= r7 && r.day <= today)
        cur[r.subject] = (cur[r.subject] || 0) + r.minutes;
      else if (r.day >= p7 && r.day <= p7End)
        prev[r.subject] = (prev[r.subject] || 0) + r.minutes;
    });
    let best = null;
    Object.keys(prev).forEach((k) => {
      if (prev[k] < 30) return;
      const c = cur[k] || 0,
        ch = pct(c, prev[k]);
      if (Math.abs(ch) >= 30 && (!best || Math.abs(ch) > Math.abs(best.ch)))
        best = { k, ch, c, p: prev[k] };
    });
    if (best) {
      const l = labels[best.k];
      out.push({
        text: `${l} is ${best.ch > 0 ? "up" : "down"} ${Math.abs(best.ch)}% on last week (${best.p} to ${best.c} min).`,
        ask:
          best.ch < 0
            ? `Why might my ${l} be down this week, and what should I change?`
            : `My ${l} is up this week. How do I keep it going?`,
      });
    }
  }
  // 2. weakest weekday
  const w = a.weekday;
  // only with enough activity, and a gap big enough to be worth saying
  if (
    w.weakest !== null &&
    w.strongest !== null &&
    a.period.activeDays >= 10 &&
    w.avg[w.strongest] >= 30 &&
    w.avg[w.weakest] < 0.7 * w.avg[w.strongest]
  )
    out.push({
      text: `Your weakest day is ${LONG[w.weakest]}: ${w.avg[w.weakest]} min on average, against ${w.avg[w.strongest]} on ${LONG[w.strongest]}.`,
      ask: `${LONG[w.weakest]} is my weakest day. How should I plan it?`,
    });
  // 3. biggest change in a disruptor
  const moved = a.disruptors
    .filter((d) => d.deltaPct !== null && Math.abs(d.deltaPct) >= 25)
    .sort((x, y) => Math.abs(y.deltaPct) - Math.abs(x.deltaPct))[0];
  if (moved)
    out.push({
      text: `${moved.label} is ${moved.deltaPct > 0 ? "up" : "down"} ${Math.abs(moved.deltaPct)}% on the previous ${a.range} days.`,
      ask:
        moved.deltaPct > 0
          ? `I'm spending more time on ${moved.label}. What can I do about it?`
          : `I'm spending less time on ${moved.label}. How do I keep that going?`,
    });
  // 4. a comeback
  const back = a.habits
    .filter((h) => h.comebacks > 0)
    .sort((x, y) => y.comebacks - x.comebacks)[0];
  if (back)
    out.push({
      text: `${back.label}: back on target after a missed week${back.comebacks > 1 ? ", " + back.comebacks + " times" : ""}.`,
      ask: `How do I stay on target with ${back.label}?`,
    });
  return out.slice(0, 3);
}

// One honest sentence. Every number in it is computed above.
function headline(range, p, misses) {
  if (!p.build && !p.stop && !misses.total)
    return `Nothing logged in the last ${range} days yet.`;
  let s = `Last ${range} days: ${p.build} min built`;
  if (p.deltaPct != null)
    s += `, ${p.deltaPct >= 0 ? "up" : "down"} ${Math.abs(p.deltaPct)}% on the ${range} before`;
  s += ".";
  if (misses.total >= 3) {
    const top = Math.max.apply(null, misses.byWeekday);
    if (top >= 2)
      s += ` You miss most often on ${LONG[misses.byWeekday.indexOf(top)]}s.`;
    const r = misses.byReason[0];
    if (r && r.reason !== "none")
      s += ` Most common reason: ${r.label} (${r.count} of ${misses.total}).`;
  }
  return s;
}

// One month for the calendar: daily totals, every entry, and recorded misses.
function calendarMonth(logs, month, tz) {
  const { rows, labels } = prepare(logs, tz);
  const days = {};
  rows
    .filter((r) => r.day.startsWith(month + "-"))
    .sort((a, b) => a.ts - b.ts)
    .forEach((r) => {
      const d = (days[r.day] = days[r.day] || {
        build: 0,
        stop: 0,
        entries: [],
        misses: [],
      });
      if (r.direction === "build" && r.minutes === 0)
        d.misses.push({
          subject: labels[r.subject],
          reason: reasonLabel(r.reason),
          note: r.text,
        });
      else if (r.minutes > 0) {
        d[r.direction] += r.minutes;
        d.entries.push({
          subject: labels[r.subject],
          minutes: r.minutes,
          type: r.direction,
          time: hhmm(r.ts, tz),
          note: r.text,
        });
      }
    });
  return days;
}

// CSV for the user's own records. Cells that start like a formula are defused.
function toCsv(logs, tz) {
  const cell = (v) => {
    let s = String(v == null ? "" : v).replace(/[\r\n]+/g, " ");
    if (/^[=+\-@\t]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = ["date,time,subject,type,minutes,reason,note"];
  (logs || [])
    .filter(
      (l) =>
        Number.isFinite(Date.parse(l.created_at)) &&
        String(l.subject || "").trim(),
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .forEach((l) => {
      const ts = Date.parse(l.created_at),
        min = Number(l.duration) || 0;
      const stopRow = l.habit_type === "stop";
      lines.push(
        [
          dayKey(ts, tz),
          hhmm(ts, tz),
          cell(String(l.subject).trim()),
          stopRow ? "disruptor" : min === 0 ? "miss" : "build",
          min,
          cell(l.reason_category || ""),
          cell(l.description || ""),
        ].join(","),
      );
    });
  return lines.join("\n") + "\n";
}

module.exports = {
  buildAnalytics,
  calendarMonth,
  toCsv,
  dayOf: dayKey,
  addDays: shiftDay,
};
