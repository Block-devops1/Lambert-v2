const test = require("node:test");
const assert = require("node:assert/strict");
const { enrichState } = require("./dashboard.js");

const NOW = Date.parse("2026-10-28T09:00:00Z"); // Wednesday, 10:00 in Owerri
const row = (day, subject, duration, type = "continue") => ({
  created_at: `${day}T12:00:00Z`,
  subject,
  duration,
  habit_type: type,
});
const run = (logs, extra = {}) =>
  enrichState({
    state: {
      habits: [
        { subject: "coding", direction: "build" },
        { subject: "gaming", direction: "stop" },
      ],
    },
    logs,
    targets: {},
    dailyGoalMin: 180,
    nowMs: NOW,
    tzOffsetMin: 60,
    ...extra,
  });

test("day one: 169 built today is on pace, not 'off track'", () => {
  const s = run([row("2026-10-28", "coding", 169)]);
  assert.equal(s.summary.todayBuild, 169);
  assert.equal(s.summary.last7Build, 169);
  assert.equal(s.summary.avgBuildPerDay, 169);
  assert.equal(s.summary.paceStatus, "on_track");
  assert.equal(s.overall.buildStreakDays, 1);
});

test("daily has 14 days, oldest first, today last", () => {
  const s = run([
    row("2026-10-27", "coding", 30),
    row("2026-10-28", "coding", 40),
  ]);
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily[13].day, "2026-10-28");
  assert.equal(s.daily[12].build, 30);
  assert.equal(s.daily[13].build, 40);
});

test("per-habit figures and target come from the logs and settings", () => {
  const s = run(
    [row("2026-10-26", "Coding", 60), row("2026-10-28", "coding", 40)],
    { targets: { coding: { daysPerWeek: 5 } } },
  );
  const h = s.habits.find((x) => x.subject === "coding");
  assert.equal(h.minutes7d, 100);
  assert.equal(h.days7d, 2);
  assert.equal(h.targetDaysPerWeek, 5);
  assert.deepEqual(h.last7Days, [
    false,
    false,
    false,
    false,
    true,
    false,
    true,
  ]);
});

test("disruptors and focus score", () => {
  const s = run([
    row("2026-10-28", "coding", 60),
    row("2026-10-28", "gaming", 20, "stop"),
  ]);
  assert.equal(s.habits.find((x) => x.subject === "gaming").minutes7d, 20);
  assert.equal(s.summary.focusScore, 75);
});

test("older saves with habit_type 'build' count as build time", () => {
  const s = run([row("2026-10-28", "coding", 50, "build")]);
  assert.equal(s.summary.todayBuild, 50);
  assert.equal(s.habits.find((x) => x.subject === "coding").minutes7d, 50);
});

test("misses (0 minutes) and unknown types are ignored; no data means null score", () => {
  const s = run([
    row("2026-10-28", "coding", 0),
    row("2026-10-28", "coding", 50, "weird"),
  ]);
  assert.equal(s.summary.todayBuild, 0);
  assert.equal(s.summary.focusScore, null);
});

test("previous 7 days are counted separately; the streak counts consecutive days", () => {
  const s = run([
    row("2026-10-20", "coding", 100),
    row("2026-10-27", "coding", 10),
    row("2026-10-28", "coding", 10),
  ]);
  assert.equal(s.summary.prev7Build, 100);
  assert.equal(s.summary.last7Build, 20);
  assert.equal(s.overall.buildStreakDays, 2);
});

test("a bad daily goal falls back to 180", () => {
  assert.equal(run([], { dailyGoalMin: undefined }).summary.dailyGoalMin, 180);
});
