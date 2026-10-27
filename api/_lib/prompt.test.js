const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../../engine/engine.js");
const { buildSystemPrompt, renderState, FIX_TEXT } = require("./prompt.js");
const { extractActions } = require("./actions.js");

const TODAY = "2026-10-27"; // Tuesday
const NOW = Date.parse("2026-10-27T21:00:00Z"); // 22:00 in Owerri

const row = (day, subject, duration, extra = {}) => ({
  created_at: `${day}T12:00:00Z`,
  subject,
  duration,
  habit_type: "continue",
  description: "",
  ...extra,
});

function sampleState(extra = {}) {
  const logs = [];
  for (const d of ["21", "22", "23", "24", "25", "26"])
    logs.push(row(`2026-10-${d}`, "bible reading", 10));
  logs.push(row("2026-10-25", "gaming", 40, { habit_type: "stop" }));
  logs.push(row("2026-10-26", "gaming", 20, { habit_type: "stop" }));
  return E.buildState({
    today: TODAY,
    nowMs: NOW,
    localHour: 22,
    targets: { "bible reading": { daysPerWeek: 7 } },
    logs,
    ...extra,
  });
}

test("rendered DATA carries the engine's numbers for a build habit", () => {
  const text = renderState(sampleState());
  assert.ok(text.includes("bible reading: streak 6 (best 6)"));
  assert.ok(text.includes("nothing logged today"));
  assert.ok(text.includes("target 7/week, status adjust"));
  assert.ok(text.includes("last 14 days 60 min in 6 sessions"));
  assert.ok(text.includes("last done 1 day ago"));
});

test("disruptors render as minutes lost, with no streak", () => {
  const text = renderState(sampleState());
  assert.ok(text.includes("gaming: 60 min lost in the last 14 days (2 times)"));
  assert.ok(!/gaming: streak/.test(text));
});

test("NEEDS A REASON lists the habit and the allowed reasons after the cutoff", () => {
  const text = renderState(sampleState());
  assert.ok(text.includes("NEEDS A REASON"));
  assert.ok(text.includes("- bible reading (week status: adjust)"));
  assert.ok(
    text.includes(
      "Allowed reasons: tired, busy, forgot, no motivation, emergency",
    ),
  );
});

test("date line has the weekday and local time", () => {
  const text = renderState(sampleState(), { localTime: "22:00" });
  assert.ok(text.includes("Date: 2026-10-27 (Tuesday), local time 22:00"));
});

test("a miss pattern shows its required fix", () => {
  const state = sampleState({
    logs: [
      row("2026-10-22", "bible reading", 0, { reason_category: "tired" }),
      row("2026-10-24", "bible reading", 0, { reason_category: "tired" }),
      row("2026-10-26", "bible reading", 0, { reason_category: "tired" }),
    ],
  });
  const text = renderState(state);
  assert.ok(text.includes('missed 3 times in 7 days, always "tired"'));
  assert.ok(text.includes(FIX_TEXT.move_slot_earlier));
});

test("app-reported metrics: only real numbers are rendered", () => {
  const text = renderState(sampleState(), {
    appMetrics: { efficiency: 72, consistency: NaN, winRate: "abc" },
  });
  assert.ok(text.includes("efficiency 72%"));
  assert.ok(!text.includes("consistency"));
  assert.ok(!text.includes("win rate"));
});

test("the system prompt has the numbers rule, the data, and the right dial text", () => {
  const prompt = buildSystemPrompt({
    state: sampleState(),
    strictnessLevel: 3,
    escalationLevel: 2,
  });
  assert.ok(prompt.includes("NUMBERS RULE"));
  assert.ok(prompt.includes("bible reading: streak 6 (best 6)"));
  assert.ok(prompt.includes("STRICT: No excuses tolerated"));
  assert.ok(prompt.includes("STRICT MODE: Be noticeably firmer"));
  assert.ok(prompt.includes("<<MISS:"));
  assert.ok(prompt.includes("<<GOAL:"));
  assert.ok(prompt.includes("<<REMEMBER:"));
  assert.ok(prompt.includes("<<CHALLENGE:"));
});

test("dial level 5 is extreme, and a missing level defaults to normal", () => {
  assert.ok(
    buildSystemPrompt({ state: sampleState(), strictnessLevel: 5 }).includes(
      "EXTREME",
    ),
  );
  assert.ok(
    buildSystemPrompt({
      state: sampleState(),
      strictnessLevel: undefined,
    }).includes("NORMAL: Direct"),
  );
});

test("the prompt never leaks undefined or NaN", () => {
  const prompt = buildSystemPrompt({
    state: sampleState(),
    goals: [{ goal: "ship v2" }],
    memories: [{ memory: "prefers short answers" }],
    weeklyChallenge: "no phone before 9",
    appMetrics: { efficiency: undefined, consistency: null, winRate: "" },
    predictions: null,
  });
  assert.ok(!/undefined|NaN/.test(prompt));
  assert.ok(prompt.includes('"ship v2"'));
  assert.ok(prompt.includes('"prefers short answers"'));
  assert.ok(prompt.includes('"no phone before 9"'));
});

test("discontinued habits are named as quit, not rendered as active", () => {
  const state = sampleState({
    discontinued: ["tiktok"],
    logs: [
      row("2026-10-26", "tiktok", 90, { habit_type: "stop" }),
      row("2026-10-26", "gaming", 20, { habit_type: "stop" }),
    ],
  });
  const text = renderState(state);
  assert.ok(
    text.includes(
      "Quit by the user (never bring up as active disruptors): tiktok",
    ),
  );
  assert.ok(!text.includes("- tiktok:"));
});

// ---------- extractActions ----------

test("a valid MISS tag becomes an action and is stripped from the reply", () => {
  const state = sampleState();
  const { reply, actions } = extractActions(
    "<<MISS: Bible Reading | tired | slept late>> Tired is a reason, not a fix. Pick an earlier slot.",
    state,
  );
  assert.deepEqual(actions, [
    {
      type: "miss",
      subject: "bible reading",
      category: "tired",
      note: "slept late",
    },
  ]);
  assert.ok(!reply.includes("<<"));
  assert.ok(reply.startsWith("Tired is a reason"));
});

test("category spelling variants are accepted", () => {
  const { actions } = extractActions(
    "<<MISS: bible reading | no motivation | meh>> ok",
    sampleState(),
  );
  assert.equal(actions[0].category, "no_motivation");
});

test("an invented habit or invalid category produces no action but the tag is still stripped", () => {
  const state = sampleState();
  const a = extractActions("<<MISS: yoga | tired | x>> hi", state);
  assert.equal(a.actions.length, 0);
  assert.equal(a.reply, "hi");
  const b = extractActions("<<MISS: bible reading | lazy | x>> hi", state);
  assert.equal(b.actions.length, 0);
});

test("a habit already logged today cannot take a miss", () => {
  const state = sampleState({
    logs: [row("2026-10-27", "bible reading", 10)],
  });
  const { actions } = extractActions(
    "<<MISS: bible reading | busy | x>> hi",
    state,
  );
  assert.equal(actions.length, 0);
});

test("a stop habit cannot take a miss", () => {
  const { actions } = extractActions(
    "<<MISS: gaming | busy | x>> hi",
    sampleState(),
  );
  assert.equal(actions.length, 0);
});

test("the same habit is only recorded once per reply, note is optional", () => {
  const { actions } = extractActions(
    "<<MISS: bible reading | busy>> a <<MISS: bible reading | tired | y>> b",
    sampleState(),
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].category, "busy");
  assert.equal(actions[0].note, "");
});

test("replies with no tag pass through untouched", () => {
  const { reply, actions } = extractActions("Plain reply.", sampleState());
  assert.equal(reply, "Plain reply.");
  assert.deepEqual(actions, []);
});

test("other tags are left alone for the client to save", () => {
  const { reply } = extractActions("<<GOAL: ship v2>> Good.", sampleState());
  assert.equal(reply, "<<GOAL: ship v2>> Good.");
});
