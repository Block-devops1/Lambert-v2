const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pullTags,
  weekStartKey,
  missRow,
  label,
} = require("../public/coach-lib.js");

test("pullTags removes a GOAL tag and returns it", () => {
  const r = pullTags(
    "<<GOAL: ship v2 by Friday>> Good. Now define the first step.",
  );
  assert.deepEqual(r.tags, [{ kind: "GOAL", value: "ship v2 by Friday" }]);
  assert.equal(r.clean, "Good. Now define the first step.");
});

test("pullTags handles several tags and tidies the spacing", () => {
  const r = pullTags(
    "Noted. <<REMEMBER: prefers short answers>> <<CHALLENGE: no phone before 9>> Start tomorrow.",
  );
  assert.deepEqual(
    r.tags.map((t) => t.kind),
    ["REMEMBER", "CHALLENGE"],
  );
  assert.equal(r.clean, "Noted. Start tomorrow.");
});

test("pullTags ignores empty tags and leaves plain text alone", () => {
  assert.deepEqual(pullTags("<<GOAL:   >> hi").tags, []);
  assert.equal(pullTags("Plain reply.").clean, "Plain reply.");
  assert.equal(pullTags(null).clean, "");
});

test("pullTags keeps multi-line tag values together", () => {
  const r = pullTags("<<REMEMBER: line one\nline two>> ok");
  assert.equal(r.tags[0].value, "line one\nline two");
  assert.equal(r.clean, "ok");
});

test("pullTags does not touch MISS tags (the server already removed them)", () => {
  assert.equal(
    pullTags("<<MISS: x | tired | y>> hi").clean,
    "<<MISS: x | tired | y>> hi",
  );
});

test("weekStartKey returns the Monday of the week", () => {
  assert.equal(weekStartKey(new Date(2026, 9, 27)), "2026-10-26"); // Tuesday
  assert.equal(weekStartKey(new Date(2026, 9, 26)), "2026-10-26"); // Monday
  assert.equal(weekStartKey(new Date(2026, 10, 1)), "2026-10-26"); // Sunday
  assert.equal(weekStartKey(new Date(2026, 10, 2)), "2026-11-02"); // next Monday
});

test("missRow builds a 0-minute build-habit row with the reason", () => {
  const row = missRow(
    { subject: "bible reading", category: "no_motivation", note: "" },
    "u1",
    "2026-10-27T21:00:00.000Z",
  );
  assert.deepEqual(row, {
    user_id: "u1",
    subject: "bible reading",
    duration: 0,
    habit_type: "continue",
    description: "no motivation",
    reason_category: "no_motivation",
    created_at: "2026-10-27T21:00:00.000Z",
  });
  assert.equal(
    missRow({ subject: "x", category: "tired", note: "slept late" }, "u", "t")
      .description,
    "slept late",
  );
  assert.equal(label("no_motivation"), "no motivation");
});
