const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAnalytics, calendarMonth, toCsv } = require("./analytics.js");

const TODAY = "2026-10-29"; // Thursday
const row = (day, subject, duration, type = "continue", extra = {}) => ({
  created_at: `${day}T12:00:00Z`,
  subject,
  duration,
  habit_type: type,
  description: "",
  reason_category: null,
  ...extra,
});
const run = (logs, o = {}) =>
  buildAnalytics({
    logs,
    today: TODAY,
    tzOffsetMin: 60,
    range: 30,
    goal: 180,
    joined: "2026-06-01",
    ...o,
  });

test("period totals, active days and goal days", () => {
  const a = run([
    row("2026-10-29", "Coding", 200),
    row("2026-10-28", "Coding", 100),
    row("2026-10-27", "Gaming", 40, "stop"),
    row("2026-09-01", "Coding", 500),
  ]);
  assert.equal(a.period.build, 300);
  assert.equal(a.period.stop, 40);
  assert.equal(a.period.activeDays, 2);
  assert.equal(a.period.goalDays, 1);
  assert.equal(a.period.focusScore, 88);
  assert.equal(a.period.spanDays, 30);
});

test("comparison with the previous period exists only when that period fully exists", () => {
  const logs = [
    row("2026-10-20", "Coding", 120),
    row("2026-09-20", "Coding", 100),
  ];
  assert.equal(run(logs).period.deltaPct, 20);
  assert.equal(
    run(logs, { joined: "2026-10-10" }).period.deltaPct,
    null,
    "account too new to compare",
  );
  assert.equal(run(logs, { joined: "2026-10-10" }).period.spanDays, 20);
});

test("older saves with habit_type 'build' count as build time", () => {
  assert.equal(
    run([row("2026-10-29", "Coding", 50, "build")]).period.build,
    50,
  );
});

test("the weekly series adds up to the period; a 7-day range is daily", () => {
  const logs = [
    row("2026-10-29", "A", 60),
    row("2026-10-22", "A", 40),
    row("2026-10-05", "A", 10),
  ];
  const a = run(logs);
  assert.equal(a.series.unit, "week");
  assert.equal(
    a.series.points.reduce((s, p) => s + p.build, 0),
    a.period.build,
  );
  const d = run(logs, { range: 7 });
  assert.equal(d.series.unit, "day");
  assert.equal(d.series.points.length, 7);
  assert.equal(d.series.points[6].label, "Thu");
  assert.equal(d.series.points[6].build, 60);
});

test("habits: minutes, days, 8-week sparkline, target status, and targets with no logs", () => {
  const logs = [];
  for (const d of ["29", "28", "27", "26", "25"])
    logs.push(row(`2026-10-${d}`, "Bible Reading", 10));
  const a = run(logs, {
    range: 7,
    targets: {
      "bible reading": { daysPerWeek: 5 },
      workout: { daysPerWeek: 4 },
    },
  });
  const b = a.habits.find((h) => h.subject === "bible reading");
  assert.equal(b.label, "Bible Reading");
  assert.equal(b.minutes, 50);
  assert.equal(b.activeDays, 5);
  assert.equal(b.status, "on_track");
  assert.equal(b.spark.length, 8);
  assert.equal(b.spark[7], 4, "this week so far: Mon 26 to Thu 29");
  const w = a.habits.find((h) => h.subject === "workout");
  assert.equal(w.minutes, 0);
  assert.equal(w.status, "off_track");
});

test("disruptors are ranked, capped at five, and the rest become 'Other'", () => {
  const logs = ["a", "b", "c", "d", "e", "f", "g"].map((s, i) =>
    row("2026-10-29", s, 10 * (i + 1), "stop"),
  );
  const a = run(logs);
  assert.equal(a.disruptors.length, 6);
  assert.equal(a.disruptors[0].label, "g");
  assert.equal(a.disruptors[5].label, "Other");
  assert.equal(a.disruptors[5].minutes, 10 + 20);
});

test("recorded misses are grouped by reason and weekday, and shape the headline", () => {
  const logs = [
    row("2026-10-29", "Reading", 0, "continue", { reason_category: "tired" }),
    row("2026-10-22", "Reading", 0, "continue", { reason_category: "tired" }),
    row("2026-10-15", "Reading", 0, "continue", { reason_category: "busy" }),
    row("2026-10-28", "Coding", 90),
  ];
  const a = run(logs);
  assert.equal(a.misses.total, 3);
  assert.deepEqual(
    a.misses.byReason.map((r) => [r.label, r.count]),
    [
      ["Tired", 2],
      ["Busy", 1],
    ],
  );
  assert.equal(a.misses.byWeekday[4], 3, "all three were Thursdays");
  assert.ok(a.headline.includes("You miss most often on Thursdays."));
  assert.ok(a.headline.includes("Most common reason: Tired (2 of 3)."));
});

test("an empty period says so instead of inventing a sentence", () => {
  assert.equal(run([]).headline, "Nothing logged in the last 30 days yet.");
});

test("calendarMonth: totals, ordered entries with local time, and misses with reasons", () => {
  const logs = [
    {
      created_at: "2026-10-14T20:30:00Z",
      subject: "Coding",
      duration: 90,
      habit_type: "continue",
      description: "deep work",
    },
    {
      created_at: "2026-10-14T08:05:00Z",
      subject: "coding",
      duration: 100,
      habit_type: "build",
      description: "",
    },
    {
      created_at: "2026-10-14T12:00:00Z",
      subject: "Codm",
      duration: 20,
      habit_type: "stop",
      description: "",
    },
    {
      created_at: "2026-10-16T12:00:00Z",
      subject: "Reading",
      duration: 0,
      habit_type: "continue",
      reason_category: "no_motivation",
      description: "meh",
    },
    {
      created_at: "2026-09-30T12:00:00Z",
      subject: "Coding",
      duration: 5,
      habit_type: "continue",
      description: "",
    },
  ];
  const m = calendarMonth(logs, "2026-10", 60);
  assert.deepEqual(Object.keys(m), ["2026-10-14", "2026-10-16"]);
  assert.equal(m["2026-10-14"].build, 190);
  assert.equal(m["2026-10-14"].stop, 20);
  assert.deepEqual(
    m["2026-10-14"].entries.map((e) => e.time),
    ["09:05", "13:00", "21:30"],
  );
  assert.deepEqual(m["2026-10-16"].misses, [
    { subject: "Reading", reason: "No motivation", note: "meh" },
  ]);
});

test("CSV quotes cells, flattens newlines and defuses formulas", () => {
  const csv = toCsv(
    [
      {
        created_at: "2026-10-29T12:00:00Z",
        subject: '=HYPERLINK("x")',
        duration: 30,
        habit_type: "continue",
        description: 'said "hi"\nbye',
      },
      {
        created_at: "2026-10-28T12:00:00Z",
        subject: "Reading",
        duration: 0,
        habit_type: "continue",
        reason_category: "tired",
        description: "",
      },
    ],
    60,
  );
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "date,time,subject,type,minutes,reason,note");
  assert.equal(lines[1], '2026-10-28,13:00,"Reading",miss,0,"tired",""');
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[2].includes('"said ""hi"" bye"'));
});
