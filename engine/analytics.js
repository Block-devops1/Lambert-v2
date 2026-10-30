// Everything the Analytics page shows is computed here: no database, no AI.
// Same rule as the rest of Lambert: numbers come from code, so they can't drift.
const { normText } = require("./engine.js");

const DAY = 86400000;
const BUILD_TYPES = new Set(["continue", "build"]); // "build" is what older saves wrote
const REASONS = {
  tired: "Tired",
  busy: "Busy",
  forgot: "Forgot",
  no_motivation: "No motivation",
  emergency: "Emergency",
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

const dayOf = (ms, tz) =>
  new Date(ms + (tz || 0) * 60000).toISOString().slice(0, 10);
const keyMs = (k) => Date.parse(k + "T00:00:00Z");
const addDays = (k, n) =>
  new Date(keyMs(k) + n * DAY).toISOString().slice(0, 10);
const diff = (a, b) => Math.round((keyMs(b) - keyMs(a)) / DAY);
const dow = (k) => new Date(keyMs(k)).getUTCDay();
const mondayOf = (k) => addDays(k, -((dow(k) + 6) % 7));
const hhmm = (ms, tz) =>
  new Date(ms + (tz || 0) * 60000).toISOString().slice(11, 16);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const reasonLabel = (r) =>
  !r ? "No reason given" : REASONS[r] || cap(String(r).replace(/_/g, " "));

// Clean rows: the user's own spelling for display, a normalised key for grouping.
function prepare(logs, tz) {
  const labels = {};
  const rows = [];
  for (const l of logs || []) {
    const ms = Date.parse(l.created_at);
    const subject = String(l.subject || "").trim();
    const type =
      l.habit_type === "stop"
        ? "stop"
        : BUILD_TYPES.has(l.habit_type)
          ? "build"
          : null;
    if (!Number.isFinite(ms) || !subject || !type) continue;
    const key = normText(subject);
    if (!labels[key]) labels[key] = subject; // newest spelling wins (logs arrive newest first)
    rows.push({
      ms,
      day: dayOf(ms, tz),
      key,
      type,
      min: Number(l.duration) || 0,
      reason: l.reason_category || null,
      note: String(l.description || "").trim(),
    });
  }
  return { rows, labels };
}

function buildAnalytics({
  logs,
  today,
  tzOffsetMin = 0,
  range = 30,
  goal = 180,
  targets = {},
  joined,
}) {
  const { rows, labels } = prepare(logs, tzOffsetMin);
  const start = addDays(today, -(range - 1));
  const joinedDay = joined && joined <= today ? joined : today;
  const effStart = start < joinedDay ? joinedDay : start;
  const spanDays = diff(effStart, today) + 1;
  const inRange = (r) => r.day >= start && r.day <= today;

  const perDay = {};
  rows.forEach((r) => {
    if (r.min > 0)
      (perDay[r.day] = perDay[r.day] || { build: 0, stop: 0 })[r.type] += r.min;
  });
  const sum = (from, to, k) => {
    let t = 0;
    for (let d = from; d <= to; d = addDays(d, 1))
      t += (perDay[d] || {})[k] || 0;
    return t;
  };

  // The period, and the same-length period before it (only when it fully exists).
  const build = sum(start, today, "build");
  const stop = sum(start, today, "stop");
  let activeDays = 0,
    goalDays = 0;
  for (let d = effStart; d <= today; d = addDays(d, 1)) {
    const b = (perDay[d] || {}).build || 0;
    if (b > 0) activeDays++;
    if (b >= goal) goalDays++;
  }
  const prevStart = addDays(today, -(2 * range - 1));
  const comparable = prevStart >= joinedDay;
  const prevBuild = comparable
    ? sum(prevStart, addDays(today, -range), "build")
    : null;
  const deltaPct =
    comparable && prevBuild > 0
      ? Math.round(((build - prevBuild) / prevBuild) * 100)
      : null;
  const period = {
    build,
    stop,
    activeDays,
    goalDays,
    spanDays,
    prevBuild,
    deltaPct,
    focusScore:
      build + stop > 0 ? Math.round((build / (build + stop)) * 100) : null,
  };

  // Trend: daily bars for a week, weekly bars for longer ranges (daily is noise over 90 days).
  const unit = range <= 7 ? "day" : "week";
  const points = [];
  if (unit === "day") {
    for (let d = start; d <= today; d = addDays(d, 1))
      points.push({
        label: SHORT[dow(d)],
        build: sum(d, d, "build"),
        stop: sum(d, d, "stop"),
        goalMin: d >= joinedDay ? goal : 0,
      });
  } else {
    for (let w = mondayOf(start); w <= today; w = addDays(w, 7)) {
      const from = w < start ? start : w;
      const end = addDays(w, 6);
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

  // Habits against their targets, with 8 weeks of history for the sparkline.
  const buildDays = {};
  rows.forEach((r) => {
    if (r.type === "build" && r.min > 0)
      (buildDays[r.key] = buildDays[r.key] || new Set()).add(r.day);
  });
  const hab = {};
  rows
    .filter((r) => r.type === "build" && r.min > 0 && inRange(r))
    .forEach((r) => {
      const h = (hab[r.key] = hab[r.key] || { minutes: 0, days: new Set() });
      h.minutes += r.min;
      h.days.add(r.day);
    });
  Object.keys(targets || {}).forEach((k) => {
    if (!hab[k]) hab[k] = { minutes: 0, days: new Set() };
  });
  const firstWeek = addDays(mondayOf(today), -49);
  const habits = Object.keys(hab)
    .map((key) => {
      const t = targets && targets[key] && targets[key].daysPerWeek;
      const spark = [];
      for (let w = 0; w < 8; w++) {
        const ws = addDays(firstWeek, w * 7);
        let n = 0;
        for (let i = 0; i < 7; i++) {
          const d = addDays(ws, i);
          if (d <= today && buildDays[key] && buildDays[key].has(d)) n++;
        }
        spark.push(n);
      }
      const expected = t ? (t * spanDays) / 7 : null;
      const ratio = expected ? hab[key].days.size / expected : null;
      return {
        subject: key,
        label: labels[key] || key,
        minutes: hab[key].minutes,
        activeDays: hab[key].days.size,
        spanDays,
        targetDaysPerWeek: t || null,
        spark,
        status:
          ratio == null || spanDays < 3
            ? null
            : ratio >= 0.8
              ? "on_track"
              : ratio >= 0.5
                ? "adjust"
                : "off_track",
      };
    })
    .sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));

  // Disruptors: top 5 and the rest grouped, so the chart stays readable.
  const dis = {};
  rows
    .filter((r) => r.type === "stop" && r.min > 0 && inRange(r))
    .forEach((r) => {
      const d = (dis[r.key] = dis[r.key] || {
        label: labels[r.key],
        minutes: 0,
        count: 0,
      });
      d.minutes += r.min;
      d.count++;
    });
  const ranked = Object.values(dis).sort((a, b) => b.minutes - a.minutes);
  const disruptors = ranked.slice(0, 5);
  if (ranked.length > 5)
    disruptors.push({
      label: "Other",
      minutes: ranked.slice(5).reduce((s, d) => s + d.minutes, 0),
      count: ranked.slice(5).reduce((s, d) => s + d.count, 0),
      other: true,
    });

  // Misses: a build habit logged with 0 minutes is a recorded miss, with its reason.
  const missRows = rows.filter(
    (r) => r.type === "build" && r.min === 0 && inRange(r),
  );
  const byReasonMap = {};
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  missRows.forEach((r) => {
    const k = r.reason || "none";
    byReasonMap[k] = (byReasonMap[k] || 0) + 1;
    byWeekday[dow(r.day)]++;
  });
  const byReason = Object.keys(byReasonMap)
    .map((k) => ({
      reason: k,
      label: reasonLabel(k === "none" ? null : k),
      count: byReasonMap[k],
    }))
    .sort((a, b) => b.count - a.count);
  const misses = { total: missRows.length, byReason, byWeekday };

  return {
    range,
    goal,
    today,
    joined: joinedDay,
    period,
    series: { unit, points },
    habits,
    disruptors,
    misses,
    headline: headline(range, period, misses),
  };
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
    .sort((a, b) => a.ms - b.ms)
    .forEach((r) => {
      const d = (days[r.day] = days[r.day] || {
        build: 0,
        stop: 0,
        entries: [],
        misses: [],
      });
      if (r.type === "build" && r.min === 0)
        d.misses.push({
          subject: labels[r.key],
          reason: reasonLabel(r.reason),
          note: r.note,
        });
      else if (r.min > 0) {
        d[r.type] += r.min;
        d.entries.push({
          subject: labels[r.key],
          minutes: r.min,
          type: r.type,
          time: hhmm(r.ms, tz),
          note: r.note,
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
  const { rows } = prepare(logs, tz);
  const raw = (logs || []).filter(
    (l) =>
      Number.isFinite(Date.parse(l.created_at)) &&
      String(l.subject || "").trim(),
  );
  raw
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .forEach((l) => {
      const ms = Date.parse(l.created_at);
      const min = Number(l.duration) || 0;
      const stop = l.habit_type === "stop";
      lines.push(
        [
          dayOf(ms, tz),
          hhmm(ms, tz),
          cell(String(l.subject).trim()),
          stop ? "disruptor" : min === 0 ? "miss" : "build",
          min,
          cell(l.reason_category || ""),
          cell(l.description || ""),
        ].join(","),
      );
    });
  return lines.join("\n") + "\n";
}

module.exports = { buildAnalytics, calendarMonth, toCsv, dayOf, addDays };
