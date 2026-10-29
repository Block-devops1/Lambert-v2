const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine");

const TODAY = "2026-10-27"; // Tuesday; its Monday is 2026-10-26

// Build a log row at midday UTC (13:00 local) so day boundaries are unambiguous.
const row = (day, subject, duration, extra = {}) => ({
  created_at: `${day}T12:00:00Z`,
  subject,
  duration,
  habit_type: "continue",
  description: "",
  ...extra,
});

test("dayKey uses Lagos time (UTC+1), not UTC", () => {
  assert.equal(E.dayKey("2026-10-26T23:30:00Z"), "2026-10-27");
  assert.equal(E.dayKey("2026-10-26T22:59:00Z"), "2026-10-26");
});

test("week math is Monday-based", () => {
  assert.equal(E.mondayOf(TODAY), "2026-10-26");
  assert.equal(E.weekIndex("2026-10-26"), 0);
  assert.equal(E.weekIndex("2026-11-01"), 6);
});

test("streak stays alive through today when today is not logged yet", () => {
  const set = new Set(["2026-10-24", "2026-10-25", "2026-10-26"]);
  const s = E.streakFor(set, TODAY);
  assert.deepEqual(s, { current: 3, longest: 3, loggedToday: false });
});

test("streak breaks on a gap and longest is remembered", () => {
  const set = new Set([
    "2026-10-15",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
    "2026-10-19",
    "2026-10-25",
    "2026-10-26",
  ]);
  const s = E.streakFor(set, TODAY);
  assert.equal(s.current, 2);
  assert.equal(s.longest, 5);
});

test("streak is 0 when yesterday and today are both empty", () => {
  const s = E.streakFor(new Set(["2026-10-20"]), TODAY);
  assert.equal(s.current, 0);
});

test("subject variants merge: 'Reading' and 'reading ' are one habit", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [row("2026-10-25", "Reading", 20), row("2026-10-26", "reading ", 30)],
  });
  assert.equal(state.habits.length, 1);
  assert.equal(state.habits[0].subject, "reading");
  assert.equal(state.habits[0].minutesThisWeek, 30);
  assert.equal(state.habits[0].minutesLastWeek, 20);
  assert.equal(state.habits[0].streak.current, 2);
});

test("alias map merges 'read' into 'reading'", () => {
  const state = E.buildState({
    today: TODAY,
    aliases: { read: "reading" },
    logs: [row("2026-10-25", "read", 10), row("2026-10-26", "reading", 10)],
  });
  assert.equal(state.habits.length, 1);
});

test("habitStatus is deterministic", () => {
  const base = { dayIndex: 1, loggedToday: false };
  assert.equal(
    E.habitStatus({ ...base, daysThisWeek: 3, targetDays: 3 }),
    "met",
  );
  assert.equal(
    E.habitStatus({ ...base, daysThisWeek: 1, targetDays: 3 }),
    "on_track",
  );
  assert.equal(
    E.habitStatus({ ...base, daysThisWeek: 1, targetDays: 7 }),
    "adjust",
  );
  assert.equal(
    E.habitStatus({ ...base, daysThisWeek: 0, targetDays: 7 }),
    "off_track",
  );
});

test("logging today gives back one day of slack", () => {
  // Target 7, Mon+Tue done: 5 needed, 5 days left after today -> adjust (zero slack).
  assert.equal(
    E.habitStatus({
      daysThisWeek: 2,
      dayIndex: 1,
      loggedToday: true,
      targetDays: 7,
    }),
    "adjust",
  );
});

test("status shows up in state only when a target exists", () => {
  const state = E.buildState({
    today: TODAY,
    targets: { workout: { daysPerWeek: 4 } },
    logs: [row("2026-10-26", "workout", 45), row("2026-10-26", "reading", 10)],
  });
  const w = state.habits.find((h) => h.subject === "workout");
  const r = state.habits.find((h) => h.subject === "reading");
  assert.equal(w.status, "on_track");
  assert.equal(r.status, null);
});

test("detects 3 misses with the same excuse, case/space insensitive", () => {
  const logs = E.cleanLogs([
    row("2026-10-22", "bible reading", 0, { description: "Tired" }),
    row("2026-10-24", "bible reading", 0, { description: "tired " }),
    row("2026-10-26", "bible reading", 0, { description: "TIRED" }),
  ]);
  const p = E.missPatterns(logs, TODAY);
  assert.equal(p.length, 1);
  assert.equal(p[0].count, 3);
  assert.equal(p[0].category, "tired");
});

test("two misses is not a pattern; old misses outside the window are ignored", () => {
  const logs = E.cleanLogs([
    row("2026-10-10", "bible reading", 0, { description: "tired" }),
    row("2026-10-11", "bible reading", 0, { description: "tired" }),
    row("2026-10-12", "bible reading", 0, { description: "tired" }),
    row("2026-10-26", "bible reading", 0, { description: "tired" }),
  ]);
  assert.equal(E.missPatterns(logs, TODAY).length, 0);
});

test("current-week challenge is picked by week_start", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [],
    challenges: [
      { week_start: "2026-10-19", challenge: "old", met: true },
      { week_start: "2026-10-26", challenge: "no phone before 9", met: false },
    ],
  });
  assert.deepEqual(state.challenge, { text: "no phone before 9", met: false });
});

test("only active goals are included", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [],
    goals: [
      { goal: "ship v2", is_active: true },
      { goal: "dead goal", is_active: false },
    ],
  });
  assert.deepEqual(state.goals, ["ship v2"]);
});

test("bad rows are dropped, null duration becomes 0", () => {
  const logs = E.cleanLogs([
    { created_at: "garbage", subject: "x", duration: 5 },
    { created_at: "2026-10-26T12:00:00Z", subject: "", duration: 5 },
    {
      created_at: "2026-10-26T12:00:00Z",
      subject: "run",
      duration: null,
      habit_type: "continue",
    },
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].minutes, 0);
});

test("validateState passes on a real state and catches corruption", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [row("2026-10-26", "workout", 45), row("2026-10-27", "workout", 30)],
  });
  assert.deepEqual(E.validateState(state), []);

  state.habits[0].minutesThisWeek = NaN;
  assert.ok(E.validateState(state).length > 0);
});

test("the incoherent-output case cannot happen: one subject has one streak", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-21", "bible reading", 10),
      row("2026-10-22", "bible reading", 10),
      row("2026-10-23", "bible reading", 10),
      row("2026-10-24", "bible reading", 10),
      row("2026-10-25", "bible reading", 10),
      row("2026-10-26", "bible reading", 10),
    ],
  });
  const h = state.habits[0];
  assert.equal(h.streak.current, 6);
  assert.equal(h.loggedToday, false);
  assert.equal(h.minutesToday, 0);
  assert.deepEqual(E.validateState(state), []);
});

// ---------- reason categories, needsReason, emergency cap ----------

const missRow = (day, subject, extra = {}) => row(day, subject, 0, extra);

test("reason_category column beats free text for pattern grouping", () => {
  const logs = E.cleanLogs([
    missRow("2026-10-22", "bible reading", {
      reason_category: "forgot",
      description: "phone died",
    }),
    missRow("2026-10-24", "bible reading", {
      reason_category: "forgot",
      description: "slept off",
    }),
    missRow("2026-10-26", "bible reading", {
      reason_category: "forgot",
      description: "",
    }),
  ]);
  const p = E.missPatterns(logs, TODAY);
  assert.equal(p.length, 1);
  assert.equal(p[0].category, "forgot");
  assert.equal(p[0].action, "add_cue");
  assert.equal(p[0].needsDecision, true);
});

test("each category maps to its fix code", () => {
  assert.deepEqual(E.FIX_FOR, {
    tired: "move_slot_earlier",
    busy: "set_minimum_version",
    forgot: "add_cue",
    no_motivation: "five_minute_start",
    emergency: "ask_followup",
  });
});

test("unclassified free-text excuses never form a pattern", () => {
  const logs = E.cleanLogs([
    missRow("2026-10-22", "workout", { description: "rain" }),
    missRow("2026-10-24", "workout", { description: "rain" }),
    missRow("2026-10-26", "workout", { description: "rain" }),
  ]);
  assert.equal(logs[0].reason, "other");
  assert.equal(E.missPatterns(logs, TODAY).length, 0);
});

test("normReason handles category, exact-name note, other, and nothing", () => {
  assert.equal(E.normReason("No Motivation", ""), "no_motivation");
  assert.equal(E.normReason(null, "Tired "), "tired");
  assert.equal(E.normReason(null, "something else"), "other");
  assert.equal(E.normReason(null, ""), null);
});

const TARGETS = {
  "bible reading": { daysPerWeek: 7 },
  workout: { daysPerWeek: 4 },
};

test("needsReason is empty before the cutoff hour and when localHour is unknown", () => {
  const args = { today: TODAY, logs: [], targets: TARGETS };
  assert.deepEqual(E.buildState({ ...args, localHour: 20 }).needsReason, []);
  assert.deepEqual(E.buildState({ ...args }).needsReason, []);
});

test("needsReason lists unlogged target habits after the cutoff", () => {
  const state = E.buildState({
    today: TODAY,
    localHour: 22,
    targets: TARGETS,
    logs: [row("2026-10-27", "workout", 30)],
  });
  assert.deepEqual(
    state.needsReason.map((n) => n.subject),
    ["bible reading"],
  );
});

test("a target habit with zero logs ever still appears and is asked about", () => {
  const state = E.buildState({
    today: TODAY,
    localHour: 22,
    targets: TARGETS,
    logs: [],
  });
  assert.equal(state.habits.length, 2);
  const b = state.habits.find((h) => h.subject === "bible reading");
  assert.equal(b.streak.current, 0);
  assert.equal(b.type, "unknown");
  assert.equal(state.needsReason.length, 2);
  assert.deepEqual(E.validateState(state), []);
});

test("no reason is asked once a miss with a reason is logged today", () => {
  const state = E.buildState({
    today: TODAY,
    localHour: 22,
    targets: TARGETS,
    logs: [
      row("2026-10-27", "workout", 30),
      missRow("2026-10-27", "bible reading", { reason_category: "tired" }),
    ],
  });
  assert.deepEqual(state.needsReason, []);
});

test("a 0-minute miss logged without a reason is still asked about", () => {
  const state = E.buildState({
    today: TODAY,
    localHour: 22,
    targets: TARGETS,
    logs: [
      row("2026-10-27", "workout", 30),
      missRow("2026-10-27", "bible reading"),
    ],
  });
  assert.deepEqual(
    state.needsReason.map((n) => n.subject),
    ["bible reading"],
  );
});

test("a habit whose weekly target is already met is not asked about", () => {
  const state = E.buildState({
    today: TODAY,
    localHour: 22,
    targets: { run: { daysPerWeek: 1 } },
    logs: [row("2026-10-26", "run", 30)],
  });
  assert.deepEqual(state.needsReason, []);
});

test("emergency cap: 3 in 30 days is over a cap of 2, 2 is not", () => {
  const three = [
    missRow("2026-10-05", "workout", { reason_category: "emergency" }),
    missRow("2026-10-15", "workout", { reason_category: "emergency" }),
    missRow("2026-10-25", "workout", { reason_category: "emergency" }),
  ];
  const over = E.buildState({ today: TODAY, logs: three, emergencyCap: 2 });
  assert.deepEqual(over.emergency, { last30Days: 3, cap: 2, overCap: true });
  const ok = E.buildState({
    today: TODAY,
    logs: three.slice(0, 2),
    emergencyCap: 2,
  });
  assert.equal(ok.emergency.overCap, false);
});

test("emergencies older than 30 days do not count", () => {
  const old = [
    missRow("2026-09-01", "workout", { reason_category: "emergency" }),
  ];
  assert.equal(
    E.buildState({ today: TODAY, logs: old }).emergency.last30Days,
    0,
  );
});

test("validateState rejects an invalid pattern category and unknown needsReason habit", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [row("2026-10-26", "workout", 20)],
  });
  state.patterns = [{ subject: "workout", category: "lazy", count: 3 }];
  state.needsReason = [{ subject: "ghost", status: null }];
  const errs = E.validateState(state);
  assert.ok(errs.some((e) => e.includes("invalid category")));
  assert.ok(errs.some((e) => e.includes("unknown habit")));
});

// ---------- build vs stop habits, windows, discontinued, overall ----------

const stopRow = (day, subject, duration, extra = {}) =>
  row(day, subject, duration, { habit_type: "stop", ...extra });

test("a stop habit has no streak and reports minutes lost, not progress", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      stopRow("2026-10-25", "gaming", 40),
      stopRow("2026-10-26", "gaming", 20),
    ],
  });
  const g = state.habits[0];
  assert.equal(g.direction, "stop");
  assert.equal(g.streak, null);
  assert.equal(g.status, null);
  assert.equal(g.minutes14d, 60);
  assert.equal(g.sessions14d, 2);
  assert.equal(g.daysSinceLast, 1);
  assert.deepEqual(E.validateState(state), []);
});

test("0-minute rows on a stop habit are dropped, never counted as misses", () => {
  const logs = E.cleanLogs([
    stopRow("2026-10-26", "gaming", 0, { description: "tired" }),
  ]);
  assert.equal(logs.length, 0);
});

test("stop habits never count toward the overall build streak", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-26", "workout", 30),
      stopRow("2026-10-26", "gaming", 60),
      stopRow("2026-10-25", "gaming", 60),
    ],
  });
  assert.equal(state.overall.buildStreakDays, 1);
});

test("discontinued stop habits are removed from state", () => {
  const state = E.buildState({
    today: TODAY,
    discontinued: ["TikTok "],
    logs: [
      stopRow("2026-10-26", "tiktok", 90),
      stopRow("2026-10-26", "gaming", 20),
    ],
  });
  assert.deepEqual(
    state.habits.map((h) => h.subject),
    ["gaming"],
  );
  assert.deepEqual(state.discontinued, ["tiktok"]);
});

test("14-day window includes day 14 back and excludes day 15", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [row("2026-10-13", "reading", 20), row("2026-10-14", "reading", 30)],
  });
  const h = state.habits[0];
  assert.equal(h.minutes14d, 30);
  assert.equal(h.sessions14d, 1);
  assert.equal(h.minutesAllTime, 50);
  assert.equal(h.sessionsAllTime, 2);
});

test("hoursSinceLastLog uses nowMs and rounds to whole hours", () => {
  const state = E.buildState({
    today: TODAY,
    nowMs: Date.parse("2026-10-27T13:00:00Z"),
    logs: [
      {
        ...row("2026-10-27", "reading", 20),
        created_at: "2026-10-27T10:00:00Z",
      },
    ],
  });
  assert.equal(state.overall.hoursSinceLastLog, 3);
  assert.equal(
    E.buildState({ today: TODAY, logs: [] }).overall.hoursSinceLastLog,
    null,
  );
});

test("recent logs are newest first, capped at 8, and keep the description text", () => {
  const logs = [];
  for (let i = 1; i <= 10; i++) {
    const day = `2026-10-${String(10 + i).padStart(2, "0")}`;
    logs.push(row(day, "reading", 10 + i, { description: `chapter ${i}` }));
  }
  const state = E.buildState({ today: TODAY, logs });
  assert.equal(state.recent.length, 8);
  assert.equal(state.recent[0].day, "2026-10-20");
  assert.equal(state.recent[0].text, "chapter 10");
  assert.equal(state.recent[7].day, "2026-10-13");
});

test("rows with no created_at are dropped, not dated 1970", () => {
  const logs = E.cleanLogs([
    { created_at: null, subject: "run", duration: 20, habit_type: "continue" },
    { subject: "run", duration: 20, habit_type: "continue" },
  ]);
  assert.equal(logs.length, 0);
});

test("a stop habit given a streak, or a build habit without one, fails validation", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-26", "workout", 20),
      stopRow("2026-10-26", "gaming", 20),
    ],
  });
  const w = state.habits.find((h) => h.subject === "workout");
  const g = state.habits.find((h) => h.subject === "gaming");
  g.streak = { current: 1, longest: 1 };
  w.streak = null;
  const errs = E.validateState(state);
  assert.ok(errs.some((e) => e.includes("stop habit must not have a streak")));
  assert.ok(errs.some((e) => e.includes("build habit has no streak")));
});

// ---------- habit_type spellings ----------

test("legacy 'build' habit_type counts as a build habit, same as 'continue'", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-26", "coding", 60, { habit_type: "build" }),
      row("2026-10-26", "reading", 30, { habit_type: "continue" }),
    ],
  });
  assert.deepEqual(
    state.habits.map((h) => h.direction),
    ["build", "build"],
  );
  assert.equal(state.overall.buildStreakDays, 1);
  assert.deepEqual(E.validateState(state), []);
});

test("any other habit_type is a stop habit", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [row("2026-10-26", "tiktok", 40, { habit_type: "quit" })],
  });
  assert.equal(state.habits[0].direction, "stop");
});

// ---------- daily series, summary, 7-day habit fields, targets sanitizer ----------

test("daily has 14 days, oldest first, build and stop split", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-27", "workout", 45),
      row("2026-10-27", "reading", 15),
      stopRow("2026-10-27", "gaming", 20),
      row("2026-10-14", "reading", 30),
    ],
  });
  assert.equal(state.daily.length, 14);
  assert.equal(state.daily[0].day, "2026-10-14");
  assert.equal(state.daily[13].day, "2026-10-27");
  assert.deepEqual(state.daily[13], { day: "2026-10-27", build: 60, stop: 20 });
  assert.equal(state.daily[0].build, 30);
});

test("summary: today, rolling 7-day totals, previous 7 days, focus score", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-27", "workout", 60),
      row("2026-10-25", "reading", 40),
      stopRow("2026-10-26", "gaming", 20),
      row("2026-10-20", "reading", 50), // previous 7 (Oct 14-20)
    ],
  });
  const s = state.summary;
  assert.equal(s.todayBuild, 60);
  assert.equal(s.last7Build, 100);
  assert.equal(s.last7Stop, 20);
  assert.equal(s.prev7Build, 50);
  assert.equal(s.avgBuildPerDay, 14);
  assert.equal(s.focusScore, 83);
  assert.deepEqual(E.validateState(state), []);
});

test("focus score is null with no logs, and pace follows the daily goal", () => {
  assert.equal(
    E.buildState({ today: TODAY, logs: [] }).summary.focusScore,
    null,
  );
  const mk = (min, goal) =>
    E.buildState({
      today: TODAY,
      dailyGoalMin: goal,
      logs: [row("2026-10-27", "x", min)],
    }).summary.paceStatus;
  assert.equal(mk(700, 100), "on_track"); // 100/day vs 100
  assert.equal(mk(420, 100), "adjust"); // 60/day vs 100
  assert.equal(mk(70, 100), "off_track"); // 10/day vs 100
});

test("an invalid dailyGoalMin falls back to 180", () => {
  assert.equal(
    E.buildState({ today: TODAY, logs: [], dailyGoalMin: 5 }).summary
      .dailyGoalMin,
    180,
  );
  assert.equal(
    E.buildState({ today: TODAY, logs: [], dailyGoalMin: "x" }).summary
      .dailyGoalMin,
    180,
  );
  assert.equal(
    E.buildState({ today: TODAY, logs: [], dailyGoalMin: 240 }).summary
      .dailyGoalMin,
    240,
  );
});

test("each habit reports 7-day minutes, active days, and a dot per day", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-27", "coding", 100),
      row("2026-10-25", "coding", 69),
      row("2026-10-19", "coding", 40),
    ],
  });
  const h = state.habits[0];
  assert.equal(h.minutes7d, 169);
  assert.equal(h.days7d, 2);
  assert.equal(h.last7Days.length, 7);
  assert.deepEqual(h.last7Days, [
    false,
    false,
    false,
    false,
    true,
    false,
    true,
  ]);
  assert.equal(h.minutes14d, 209);
});

test("sanitizeTargets keeps only valid subject -> daysPerWeek entries", () => {
  const t = E.sanitizeTargets({
    "Bible Reading": { daysPerWeek: 7 },
    workout: { daysPerWeek: 4 },
    zero: { daysPerWeek: 0 },
    big: { daysPerWeek: 9 },
    frac: { daysPerWeek: 2.5 },
    str: { daysPerWeek: "3" },
    nul: null,
    "": { daysPerWeek: 3 },
  });
  assert.deepEqual(t, {
    "bible reading": { daysPerWeek: 7 },
    workout: { daysPerWeek: 4 },
  });
  assert.deepEqual(E.sanitizeTargets(null), {});
  assert.deepEqual(E.sanitizeTargets([1, 2]), {});
  assert.deepEqual(E.sanitizeTargets("x"), {});
});

test("habits keep the user's capitalisation as a display label", () => {
  const state = E.buildState({
    today: TODAY,
    logs: [
      row("2026-10-25", "Bible Reading", 10),
      row("2026-10-26", "bible reading ", 10),
    ],
  });
  assert.equal(state.habits.length, 1);
  assert.equal(state.habits[0].subject, "bible reading");
  assert.equal(state.habits[0].label, "bible reading"); // newest log's spelling wins
  const only = E.buildState({
    today: TODAY,
    logs: [row("2026-10-26", "Coding", 30)],
  });
  assert.equal(only.habits[0].label, "Coding");
  const target = E.buildState({
    today: TODAY,
    logs: [],
    targets: { Workout: { daysPerWeek: 3 } },
  });
  assert.equal(target.habits[0].label, "workout");
});
