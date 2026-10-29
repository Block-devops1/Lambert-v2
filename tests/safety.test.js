const test = require("node:test");
const assert = require("node:assert/strict");
const {
  looksLikeCrisis,
  CRISIS_PROMPT,
  stripTags,
} = require("../api/_lib/safety.js");

test("catches clear crisis wording, including curly apostrophes, caps and Pidgin", () => {
  for (const msg of [
    "I want to kill myself",
    "i've been feeling suicidal",
    "I WANT TO DIE",
    "i wan die",
    "I don\u2019t want to live anymore",
    "i no wan live again",
    "thinking about ending my life",
    "I keep wanting to hurt myself",
    "self-harm again today",
    "better off dead",
    "he beats me up when I miss chores",
    "I was raped last year",
    "I'm in danger",
    "i am not safe at home",
  ])
    assert.equal(looksLikeCrisis(msg), true, msg);
});

test("ordinary coaching talk does not trigger it", () => {
  for (const msg of [
    "I will kill it at the gym today",
    "I need to kill my phone habit",
    "this assignment is killing me",
    "my competitor is beating me in sales",
    "what should I work on today",
    "I want to improve my sleep",
    "end of the day review",
    "I hit my goal",
    "",
  ])
    assert.equal(looksLikeCrisis(msg), false, msg);
  assert.equal(looksLikeCrisis(null), false);
  assert.equal(looksLikeCrisis(undefined), false);
});

test("the crisis prompt has no persona, data, numbers rule or tag instructions", () => {
  assert.ok(!CRISIS_PROMPT.includes("NUMBERS RULE"));
  assert.ok(!CRISIS_PROMPT.includes("DATA"));
  assert.ok(!/roast the|brutally honest/i.test(CRISIS_PROMPT));
  assert.ok(CRISIS_PROMPT.includes("Drop the coaching persona"));
  assert.ok(
    CRISIS_PROMPT.includes(
      "Do not use markdown, lists, headers or any <<...>> tags",
    ),
  );
  assert.ok(CRISIS_PROMPT.includes("cannot contact anyone"));
  assert.deepEqual(
    CRISIS_PROMPT.split("").filter((c) => c.charCodeAt(0) > 127),
    [],
  );
});

test("stripTags removes every tag kind and tidies spacing", () => {
  assert.equal(
    stripTags(
      "<<MISS: x | tired | y>> I hear you. <<GOAL: ship>> <<REMEMBER: z>> Stay safe. <<ANYTHING: q>>",
    ),
    "I hear you. Stay safe.",
  );
  assert.equal(stripTags("No tags here."), "No tags here.");
  assert.equal(stripTags(null), "");
  assert.equal(stripTags("<<CHALLENGE: line one\nline two>> ok"), "ok");
});
