const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAnalytics, calendarMonth, toCsv } = require("./analytics.js");

const TODAY = "2026-10-29"; // Thursday; this week started Monday 2026-10-26
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
const days = (list, subject, minutes = 30) =>
  list.map((d) => row(d, subject, minutes));

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
  assert.equal(run(logs, { joined: "2026-10-10" }).period.deltaPct, null);
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

test("this week's status comes from the engine's Monday-week rule, not from the chosen range", () => {
  const logs = days(
    ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"],
    "Bible Reading",
    10,
  );
  const a = run(logs, {
    range: 7,
    targets: {
      "bible reading": { daysPerWeek: 5 },
      workout: { daysPerWeek: 4 },
    },
  });
  const b = a.habits.find((h) => h.subject === "bible reading");
  assert.equal(b.label, "Bible Reading");
  assert.deepEqual(
    [b.minutes, b.sessions, b.avgSession, b.activeDays],
    [40, 4, 10, 4],
  );
  assert.deepEqual(b.thisWeek, { daysDone: 4, target: 5, status: "on_track" });
  assert.deepEqual(
    b.weekly,
    { scores: [], weeksMet: 0, fullWeeks: 0 },
    "no completed week yet",
  );
  assert.equal(b.strength, null);
  const w = a.habits.find((h) => h.subject === "workout");
  assert.equal(w.minutes, 0);
  assert.equal(w.thisWeek.status, "adjust");
  assert.equal(w.strength, null);
  assert.equal(
    run(logs, { range: 90, targets: { "bible reading": { daysPerWeek: 5 } } })
      .habits[0].thisWeek.status,
    "on_track",
    "same on every range",
  );
});

test("strength, weekly scores and comebacks are the engine's numbers, not a second formula", () => {
  const E = require("./engine.js");
  const logs = [
    "2026-09-21",
    "2026-09-22",
    "2026-09-23",
    "2026-09-24",
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
  ].map((d) => row(d, "Reading", 30));
  const state = E.buildState({
    logs,
    targets: { reading: { daysPerWeek: 4 } },
    today: TODAY,
    nowMs: Date.parse("2026-10-29T10:00:00Z"),
    tzOffsetMin: 60,
  });
  const eng = state.habits.find((h) => h.subject === "reading");
  const h = run(logs, { targets: { reading: { daysPerWeek: 4 } } }).habits[0];
  assert.equal(h.strength, Math.round(eng.strength.value * 100));
  assert.deepEqual(h.weekly.scores, eng.weekly.scores);
  assert.deepEqual(h.streak, eng.streak);
});

test("habit strength dips after a missed week, never resets, and recovers", () => {
  // target 4 days a week; completed weeks starting 09-21, 09-28, 10-05, 10-12, 10-19
  const week = (monday) =>
    [0, 1, 2, 3].map((i) =>
      new Date(Date.parse(monday + "T00:00:00Z") + i * 86400000)
        .toISOString()
        .slice(0, 10),
    );
  const logs = [].concat(
    ...["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-19"].map((m) =>
      days(week(m), "Reading"),
    ),
  );
  const h = run(logs, { targets: { reading: { daysPerWeek: 4 } } }).habits[0];
  // scores 1, 1, 1, 0, 1 -> 1, 1, 1, 0.7, 0.79
  assert.equal(h.strength, 79);
  assert.equal(h.strengthDelta, 9);
  assert.deepEqual(h.weekly, {
    scores: [1, 1, 1, 0, 1],
    weeksMet: 4,
    fullWeeks: 5,
  });
  assert.equal(h.comebacks, 1);
  assert.deepEqual(h.thisWeek, { daysDone: 0, target: 4, status: "adjust" });
});

test("strength needs a target and two completed weeks", () => {
  const logs = days(
    ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
    "Reading",
  ); // began in the last completed week
  assert.equal(
    run(logs, { targets: { reading: { daysPerWeek: 4 } } }).habits[0].strength,
    null,
    "only one completed week",
  );
  const midweek = days(
    ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"],
    "Reading",
  ); // began on a Tuesday
  assert.equal(
    run(midweek, { targets: { reading: { daysPerWeek: 4 } } }).habits[0]
      .strength,
    null,
    "the first partial week is not counted",
  );
  assert.equal(run(logs).habits[0].strength, null, "no target, no strength");
});

test("the streak keeps its best and says so when it is broken", () => {
  const logs = days(
    [
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-24",
      "2026-10-25",
    ],
    "Coding",
  );
  const a = run(logs);
  assert.equal(a.streak.longest, 5);
  assert.equal(a.streak.current, 0, "yesterday and today are empty");
  assert.equal(
    run(days(["2026-10-28", "2026-10-29"], "Coding")).streak.current,
    2,
  );
});

test("disruptors: ranked, trend, share of total, days since, capped at five plus Other", () => {
  const logs = [
    row("2026-10-29", "Codm", 120, "stop"),
    row("2026-10-26", "Codm", 60, "stop"),
    row("2026-09-20", "Codm", 90, "stop"),
    row("2026-10-20", "Movies", 60, "stop"),
  ];
  const d = run(logs).disruptors;
  assert.deepEqual(
    d.map((x) => x.label),
    ["Codm", "Movies"],
  );
  assert.equal(d[0].minutes, 180);
  assert.equal(d[0].share, 75);
  assert.equal(d[0].deltaPct, 100);
  assert.equal(d[0].daysSince, 0);
  assert.equal(d[1].daysSince, 9);
  assert.equal(
    d[1].deltaPct,
    null,
    "nothing in the previous period to compare with",
  );
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((s, i) =>
    row("2026-10-29", s, 10 * (i + 1), "stop"),
  );
  const m = run(many).disruptors;
  assert.equal(m.length, 6);
  assert.equal(m[5].label, "Other");
  assert.equal(m[5].minutes, 30);
});

test("recorded misses by reason and weekday, and the headline", () => {
  const logs = [
    row("2026-10-29", "Reading", 0, "continue", { reason_category: "tired" }),
    row("2026-10-22", "Reading", 0, "continue", { reason_category: "tired" }),
    row("2026-10-15", "Reading", 0, "continue", { reason_category: "busy" }),
    row("2026-10-28", "Coding", 90),
  ];
  const a = run(logs);
  assert.deepEqual(
    a.misses.byReason.map((r) => [r.label, r.count]),
    [
      ["Tired", 2],
      ["Busy", 1],
    ],
  );
  assert.equal(a.misses.byWeekday[4], 3);
  assert.ok(a.headline.includes("You miss most often on Thursdays."));
  assert.ok(a.headline.includes("Most common reason: Tired (2 of 3)."));
  assert.equal(run([]).headline, "Nothing logged in the last 30 days yet.");
});

test("weekday averages find the weakest day, but only with two weeks of data", () => {
  const logs = [];
  for (let i = 0; i < 28; i++) {
    // every day 100 min, except Thursdays 20
    const d = new Date(Date.parse("2026-10-29T00:00:00Z") - i * 86400000)
      .toISOString()
      .slice(0, 10);
    logs.push(
      row(d, "Coding", new Date(d + "T00:00:00Z").getUTCDay() === 4 ? 20 : 100),
    );
  }
  const w = run(logs, { joined: "2026-10-02" }).weekday;
  assert.equal(w.avg[4], 20);
  assert.equal(w.weakest, 4);
  assert.equal(w.avg[w.strongest], 100);
  assert.equal(
    run(days(["2026-10-29"], "Coding"), { joined: "2026-10-20" }).weekday
      .weakest,
    null,
  );
});

test("insights are short sentences built from the numbers, at most three", () => {
  const logs = [].concat(
    days(["2026-10-28", "2026-10-29"], "Reading", 10), // this rolling week: 20
    days(
      ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"],
      "Reading",
      20,
    ), // the week before: 80
  );
  const a = run(logs);
  assert.equal(
    a.insights[0].text,
    "Reading is down 75% on last week (80 to 20 min).",
  );
  assert.ok(a.insights[0].ask.includes("Reading"));
  assert.ok(a.insights.length <= 3);
  assert.deepEqual(run([]).insights, []);
});

test("truncation is passed through so the page can say so", () => {
  assert.equal(run([], { truncated: true }).truncated, true);
  assert.equal(run([]).truncated, false);
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
  assert.equal(m["2026-10-16"].misses[0].reason, "No motivation");
  assert.equal(m["2026-10-16"].misses[0].subject, "Reading");
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

test("a weakest-day insight needs enough activity; sparse data says nothing about weekdays", () => {
  const sparse = run(days(["2026-10-29", "2026-10-28"], "Coding", 100), {
    joined: "2026-10-01",
  });
  assert.ok(!sparse.insights.some((i) => i.text.includes("weakest day")));
});
