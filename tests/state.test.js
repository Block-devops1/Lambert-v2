const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Stub the server db client before the handler loads it.
const dbPath = require.resolve("../api/_lib/db.js");
let fake;
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { db: () => fake },
};
const handler = require("../api/state.js");

const iso = (daysAgo, hour = 11) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
};

function makeDb({
  user = { id: "u1" },
  access = { status: "approved", is_admin: false },
  accessErr = null,
  logs = [],
  settings = null,
  settingsErr = null,
  goals = [],
} = {}) {
  const tables = {
    user_access: { data: access, error: accessErr },
    habit_logs: { data: logs, error: null },
    lambert_settings: { data: settings, error: settingsErr },
    lambert_goals: { data: goals, error: null },
  };
  return {
    auth: {
      getUser: async (t) =>
        t === "good" && user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: "bad" } },
    },
    from(name) {
      const r = tables[name];
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve(r),
        then: (res, rej) => Promise.resolve(r).then(res, rej),
      };
      return q;
    },
  };
}

const call = async (
  headers = { authorization: "Bearer good" },
  method = "GET",
) => {
  const out = { code: 200, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => (out.headers[k] = v),
    status(c) {
      out.code = c;
      return this;
    },
    json(b) {
      out.body = b;
      return this;
    },
  };
  await handler({ method, headers }, res);
  return out;
};

test("rejects non-GET, missing token, and a bad token", async () => {
  fake = makeDb();
  assert.equal((await call({}, "POST")).code, 405);
  assert.equal((await call({})).code, 401);
  assert.equal((await call({ authorization: "Bearer nope" })).code, 401);
});

test("blocks pending users, allows admins, separates a DB error from a missing row", async () => {
  fake = makeDb({ access: { status: "pending", is_admin: false } });
  assert.equal((await call()).code, 403);
  fake = makeDb({ access: { status: "pending", is_admin: true } });
  assert.equal((await call()).code, 200);
  fake = makeDb({ access: null });
  const missing = await call();
  assert.equal(missing.code, 403);
  assert.equal(missing.body.error, "No access record found");
  fake = makeDb({ access: null, accessErr: { message: "db down" } });
  const broken = await call();
  assert.equal(broken.code, 500);
  assert.equal(broken.body.error, "Access lookup failed");
});

test("returns engine state with summary, daily series and targets applied", async () => {
  fake = makeDb({
    logs: [
      {
        subject: "Coding",
        duration: 120,
        habit_type: "continue",
        description: "",
        reason_category: null,
        created_at: iso(0),
      },
      {
        subject: "coding",
        duration: 49,
        habit_type: "build",
        description: "",
        reason_category: null,
        created_at: iso(1),
      },
      {
        subject: "gaming",
        duration: 30,
        habit_type: "stop",
        description: "",
        reason_category: null,
        created_at: iso(1),
      },
    ],
    settings: {
      daily_goal_min: 240,
      targets: { coding: { daysPerWeek: 5 }, junk: { daysPerWeek: 99 } },
    },
    goals: [{ goal: "ship v2" }],
  });
  const r = await call();
  assert.equal(r.code, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  const { state, goalText, targets } = r.body;
  assert.equal(goalText, "ship v2");
  assert.deepEqual(targets, { coding: { daysPerWeek: 5 } });
  assert.equal(state.summary.dailyGoalMin, 240);
  assert.equal(state.daily.length, 14);
  const coding = state.habits.find((h) => h.subject === "coding");
  assert.equal(coding.direction, "build");
  assert.equal(coding.targetDaysPerWeek, 5);
  assert.ok(["on_track", "adjust", "off_track", "met"].includes(coding.status));
  assert.equal(coding.minutes7d, 169);
});

test("a settings failure falls back to defaults and reports a warning", async () => {
  fake = makeDb({
    settingsErr: { message: "relation does not exist" },
    logs: [],
  });
  const r = await call();
  assert.equal(r.code, 200);
  assert.equal(r.body.state.summary.dailyGoalMin, 180);
  assert.deepEqual(r.body.warnings, ["settings_unavailable"]);
});

test("a logs failure is a clear 500, not an empty dashboard", async () => {
  fake = makeDb();
  const base = fake.from.bind(fake);
  fake.from = (name) => {
    const q = base(name);
    if (name === "habit_logs")
      q.then = (res) =>
        Promise.resolve({ data: null, error: { message: "boom" } }).then(res);
    return q;
  };
  const r = await call();
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "Couldn't load your logs");
});
