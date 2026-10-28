// Lambert v2 engine. Pure functions only: no network, no database, no AI.
// Input: raw rows from Supabase. Output: one state object the AI layer must obey.
// Schema it reads:
//   habit_logs(id, created_at, subject, duration, habit_type, user_id, description, reason_category)
//   lambert_challenges(id, user_id, challenge, week_start, met, created_at)
//
// habit_type "continue" is a BUILD habit: minutes are good, and a streak is
// consecutive days with minutes logged. Any other value is a STOP habit
// (disruptor): minutes are time LOST, so there is no streak, only days since
// it last happened.

// Owerri/Lagos is UTC+1 all year (no DST). Day boundaries must use local time,
// otherwise a 11:30pm log lands on the wrong day and breaks streaks.
const DEFAULT_TZ_OFFSET_MIN = 60;

const BUILD_TYPE = "continue";

// Why a habit was missed. The user picks one; free text is kept alongside it.
// Each category maps to a fix code. The engine never writes prose: the voice
// layer turns the code into words.
const REASON_CATEGORIES = [
  "tired",
  "busy",
  "forgot",
  "no_motivation",
  "emergency",
];
const FIX_FOR = {
  tired: "move_slot_earlier",
  busy: "set_minimum_version",
  forgot: "add_cue",
  no_motivation: "five_minute_start",
  emergency: "ask_followup",
};

function dayKey(ts, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + tzOffsetMin * 60000).toISOString().slice(0, 10);
}

function shiftDay(key, n) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday-based week. Index: Mon=0 ... Sun=6.
function weekIndex(key) {
  return (new Date(key + "T00:00:00Z").getUTCDay() + 6) % 7;
}

function mondayOf(key) {
  return shiftDay(key, -weekIndex(key));
}

// "Reading" and "reading " must be the same subject. Optional alias map merges
// variants like "read" -> "reading".
function normText(s, aliases = {}) {
  const k = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return aliases[k] ?? k;
}

// category wins; otherwise a description that is exactly a category name counts;
// any other text is "other"; nothing at all is null (no reason given yet).
function normReason(category, note) {
  const c = normText(category).replace(/ /g, "_");
  if (REASON_CATEGORIES.includes(c)) return c;
  const n = normText(note).replace(/ /g, "_");
  if (REASON_CATEGORIES.includes(n)) return n;
  return n || c ? "other" : null;
}

// Keep only usable rows. duration is treated as minutes; null/NaN becomes 0.
// A 0-minute row only means something on a build habit (it records a miss),
// so 0-minute stop rows are dropped.
function cleanLogs(
  rows,
  { tzOffsetMin = DEFAULT_TZ_OFFSET_MIN, aliases = {} } = {},
) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.created_at) continue;
    const day = dayKey(r.created_at, tzOffsetMin);
    const subject = normText(r.subject, aliases);
    if (!day || !subject) continue;
    const type = normText(r.habit_type) || "unknown";
    const direction = type === BUILD_TYPE ? "build" : "stop";
    const minutes =
      Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0;
    if (direction === "stop" && minutes === 0) continue;
    out.push({
      day,
      ts: new Date(r.created_at).getTime(),
      subject,
      minutes,
      type,
      direction,
      note: normText(r.description),
      text: String(r.description ?? "").trim(),
      reason: normReason(r.reason_category, r.description),
    });
  }
  return out;
}

// A day counts toward a streak only if minutes > 0 were logged.
// A streak stays alive through today if today isn't logged yet.
function streakFor(daySet, today) {
  let cursor = daySet.has(today) ? today : shiftDay(today, -1);
  let current = 0;
  while (daySet.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of [...daySet].sort()) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  return { current, longest, loggedToday: daySet.has(today) };
}

// Deterministic goal status for a build habit with a days-per-week target.
//   met       -> target already reached this week
//   off_track -> not enough days left to reach it
//   adjust    -> reachable only if every remaining day is hit (zero slack)
//   on_track  -> reachable with slack
function habitStatus({ daysThisWeek, dayIndex, loggedToday, targetDays }) {
  const needed = targetDays - daysThisWeek;
  if (needed <= 0) return "met";
  const remaining = loggedToday ? 6 - dayIndex : 7 - dayIndex;
  if (needed > remaining) return "off_track";
  if (needed === remaining) return "adjust";
  return "on_track";
}

// Repeated misses with the same reason category. A "miss" is a build-habit log
// row with 0 minutes. "other" and unspecified reasons never form a pattern.
function missPatterns(logs, today, { windowDays = 7, minCount = 3 } = {}) {
  const from = shiftDay(today, -(windowDays - 1));
  const counts = new Map();
  for (const l of logs) {
    if (l.direction !== "build" || l.minutes !== 0) continue;
    if (l.day < from || l.day > today) continue;
    if (!REASON_CATEGORIES.includes(l.reason)) continue;
    const k = l.subject + "\u0000" + l.reason;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  for (const [k, count] of counts) {
    if (count < minCount) continue;
    const [subject, category] = k.split("\u0000");
    out.push({
      subject,
      category,
      count,
      windowDays,
      action: FIX_FOR[category],
      needsDecision: true, // user must accept or decline the fix
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// Emergencies are the easiest reason to abuse, so they are counted and capped.
function emergencyCount(logs, today, windowDays = 30) {
  const from = shiftDay(today, -(windowDays - 1));
  return logs.filter(
    (l) =>
      l.direction === "build" &&
      l.minutes === 0 &&
      l.reason === "emergency" &&
      l.day >= from &&
      l.day <= today,
  ).length;
}

// targets: { "bible reading": { daysPerWeek: 7 }, workout: { daysPerWeek: 4 } }
// discontinued: subjects of stop habits the user has quit; they are dropped.
// nowMs: used only for hoursSinceLastLog.
function buildState({
  logs: rawLogs,
  goals = [],
  challenges = [],
  targets = {},
  discontinued = [],
  today,
  nowMs = Date.now(),
  tzOffsetMin = DEFAULT_TZ_OFFSET_MIN,
  aliases = {},
  localHour = null, // 0-23 in local time; null means "don't ask for reasons"
  cutoffHour = 21, // after this hour, unlogged habits need a reason
  emergencyCap = 2, // emergency misses allowed per 30 days
}) {
  if (!today) throw new Error("buildState requires today (YYYY-MM-DD, local)");
  const dropped = new Set(
    (discontinued || []).map((d) => normText(d, aliases)),
  );
  const logs = cleanLogs(rawLogs, { tzOffsetMin, aliases }).filter(
    (l) => !(l.direction === "stop" && dropped.has(l.subject)),
  );
  const weekStart = mondayOf(today);
  const lastWeekStart = shiftDay(weekStart, -7);
  const from14 = shiftDay(today, -13);
  const dayIndex = weekIndex(today);

  const tmap = {};
  for (const k of Object.keys(targets)) tmap[normText(k, aliases)] = targets[k];

  const bySubject = new Map();
  for (const l of logs) {
    if (!bySubject.has(l.subject)) bySubject.set(l.subject, []);
    bySubject.get(l.subject).push(l);
  }
  // A habit with a target must exist even if it has never been logged.
  for (const s of Object.keys(tmap))
    if (!bySubject.has(s)) bySubject.set(s, []);

  const habits = [];
  for (const [subject, rows] of bySubject) {
    const direction = rows[0] ? rows[0].direction : "build";
    const done = rows.filter((r) => r.minutes > 0);
    const doneDays = new Set(done.map((r) => r.day));
    const sum = (pred) =>
      rows.filter(pred).reduce((acc, r) => acc + r.minutes, 0);
    const inWeek = (r) => r.day >= weekStart && r.day <= today;
    const inLastWeek = (r) => r.day >= lastWeekStart && r.day < weekStart;
    const in14 = (r) => r.day >= from14 && r.day <= today;
    const lastDay = [...doneDays].sort().pop() || null;
    const loggedToday = doneDays.has(today);
    const daysThisWeek = [...doneDays].filter(
      (d) => d >= weekStart && d <= today,
    ).length;

    const base = {
      subject,
      type: rows[0] ? rows[0].type : "unknown",
      direction,
      loggedToday,
      minutesToday: sum((r) => r.day === today),
      minutesThisWeek: sum(inWeek),
      minutesLastWeek: sum(inLastWeek),
      minutes14d: sum(in14),
      sessions14d: done.filter(in14).length,
      minutesAllTime: sum(() => true),
      sessionsAllTime: done.length,
      daysThisWeek,
      daysSinceLast: lastDay
        ? Math.round(
            (Date.parse(today + "T00:00:00Z") -
              Date.parse(lastDay + "T00:00:00Z")) /
              86400000,
          )
        : null,
    };

    if (direction === "stop") {
      habits.push({
        ...base,
        streak: null,
        missToday: null,
        targetDaysPerWeek: null,
        status: null,
      });
      continue;
    }

    const streak = streakFor(doneDays, today);
    const target = tmap[subject] ? tmap[subject].daysPerWeek : null;
    const missRow = rows.find((r) => r.day === today && r.minutes === 0);
    habits.push({
      ...base,
      streak: { current: streak.current, longest: streak.longest },
      missToday: loggedToday || !missRow ? null : { reason: missRow.reason },
      targetDaysPerWeek: target,
      status:
        target == null
          ? null
          : habitStatus({
              daysThisWeek,
              dayIndex,
              loggedToday,
              targetDays: target,
            }),
    });
  }
  habits.sort((a, b) => a.subject.localeCompare(b.subject));

  const challenge = challenges.find((c) => c.week_start === weekStart) || null;

  // Habits Lambert must ask "why?" about: build habit with a target, week target
  // not already met, nothing logged today, no reason recorded yet, past the cutoff.
  const pastCutoff = localHour != null && localHour >= cutoffHour;
  const needsReason = pastCutoff
    ? habits
        .filter(
          (h) =>
            h.direction === "build" &&
            h.targetDaysPerWeek != null &&
            h.status !== "met" &&
            !h.loggedToday &&
            (h.missToday == null || h.missToday.reason == null),
        )
        .map((h) => ({ subject: h.subject, status: h.status }))
    : [];

  const buildDays = new Set(
    logs
      .filter((l) => l.direction === "build" && l.minutes > 0)
      .map((l) => l.day),
  );
  const lastTs = logs.reduce((m, l) => Math.max(m, l.ts), -Infinity);
  const emergencies = emergencyCount(logs, today);

  const recent = [...logs]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8)
    .map((l) => ({
      day: l.day,
      subject: l.subject,
      direction: l.direction,
      minutes: l.minutes,
      text: l.text,
    }));

  return {
    asOf: today,
    week: { start: weekStart, dayIndex, daysLeftAfterToday: 6 - dayIndex },
    overall: {
      buildStreakDays: streakFor(buildDays, today).current,
      hoursSinceLastLog: Number.isFinite(lastTs)
        ? Math.max(0, Math.round((nowMs - lastTs) / 3600000))
        : null,
    },
    habits,
    patterns: missPatterns(logs, today),
    needsReason,
    reasonCategories: REASON_CATEGORIES,
    emergency: {
      last30Days: emergencies,
      cap: emergencyCap,
      overCap: emergencies > emergencyCap,
    },
    recent,
    discontinued: [...dropped],
    goals: goals.filter((g) => g.is_active).map((g) => g.goal),
    challenge: challenge
      ? { text: challenge.challenge, met: challenge.met }
      : null,
  };
}

// The AI layer must call this and refuse to talk to the model if it returns errors.
function validateState(state) {
  const errors = [];
  const num = (v, path) => {
    if (!Number.isFinite(v) || v < 0)
      errors.push(`${path} is not a non-negative number: ${v}`);
  };
  if (!state || !state.asOf) errors.push("missing asOf");
  for (const h of (state && state.habits) || []) {
    const p = `habit[${h.subject}]`;
    num(h.minutesToday, `${p}.minutesToday`);
    num(h.minutesThisWeek, `${p}.minutesThisWeek`);
    num(h.minutesLastWeek, `${p}.minutesLastWeek`);
    num(h.minutes14d, `${p}.minutes14d`);
    num(h.sessions14d, `${p}.sessions14d`);
    num(h.minutesAllTime, `${p}.minutesAllTime`);
    num(h.daysThisWeek, `${p}.daysThisWeek`);
    if (h.direction === "build") {
      if (!h.streak) {
        errors.push(`${p} build habit has no streak`);
      } else {
        num(h.streak.current, `${p}.streak.current`);
        num(h.streak.longest, `${p}.streak.longest`);
        if (h.streak.current > h.streak.longest)
          errors.push(`${p} current streak exceeds longest`);
      }
    } else if (h.streak) {
      errors.push(`${p} stop habit must not have a streak`);
    }
    if (h.daysThisWeek > 7) errors.push(`${p} daysThisWeek > 7`);
    if (h.loggedToday && h.minutesToday === 0)
      errors.push(`${p} loggedToday but 0 minutes`);
    if (h.minutesToday > h.minutesThisWeek)
      errors.push(`${p} minutesToday exceeds week total`);
    if (h.minutes14d > h.minutesAllTime)
      errors.push(`${p} 14-day total exceeds all-time total`);
  }
  const subjects = new Set(
    ((state && state.habits) || []).map((h) => h.subject),
  );
  for (const n of (state && state.needsReason) || []) {
    if (!subjects.has(n.subject))
      errors.push(`needsReason names unknown habit: ${n.subject}`);
  }
  for (const pt of (state && state.patterns) || []) {
    if (!REASON_CATEGORIES.includes(pt.category))
      errors.push(`pattern has invalid category: ${pt.category}`);
    num(pt.count, `pattern[${pt.subject}].count`);
  }
  if (state && state.emergency) {
    num(state.emergency.last30Days, "emergency.last30Days");
    num(state.emergency.cap, "emergency.cap");
  }
  if (state && state.overall)
    num(state.overall.buildStreakDays, "overall.buildStreakDays");
  return errors;
}

function sanitizeTargets(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [subject, v] of Object.entries(raw)) {
    const key = normText(subject);
    const d = v ? Number(v.daysPerWeek) : NaN;
    if (key && Number.isInteger(d) && d >= 1 && d <= 7) {
      out[key] = { daysPerWeek: d };
    }
  }
  return out;
}

module.exports = {
  BUILD_TYPE,
  dayKey,
  shiftDay,
  weekIndex,
  mondayOf,
  normText,
  normReason,
  cleanLogs,
  streakFor,
  habitStatus,
  missPatterns,
  emergencyCount,
  REASON_CATEGORIES,
  FIX_FOR,
  buildState,
  validateState,
  sanitizeTargets,
};
