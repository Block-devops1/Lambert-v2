const test = require("node:test");
const assert = require("node:assert/strict");

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
let fake, who;
stub("../api/_lib/db.js", { db: () => fake });
stub("../api/_lib/auth.js", { getApprovedUser: async () => who });
const handler = require("../api/analytics.js");

function makeDb({
  logs = [],
  logsErr = null,
  settings = null,
  access = { created_at: "2026-06-01T10:00:00Z" },
} = {}) {
  const seen = [];
  const tables = {
    habit_logs: { data: logs, error: logsErr },
    lambert_settings: { data: settings, error: null },
    user_access: { data: access, error: null },
  };
  return {
    seen,
    from(name) {
      const r = tables[name];
      const q = {
        select: () => q,
        eq: (c, v) => (seen.push([name, c, v]), q),
        order: () => q,
        limit: () => q,
        gte: (c, v) => (seen.push([name, "gte", v]), q),
        lt: (c, v) => (seen.push([name, "lt", v]), q),
        maybeSingle: () => Promise.resolve(r),
        then: (a, b) => Promise.resolve(r).then(a, b),
      };
      return q;
    },
  };
}
const call = async (query = {}, method = "GET") => {
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
    send(b) {
      out.body = b;
      return this;
    },
  };
  await handler({ method, headers: { authorization: "Bearer x" }, query }, res);
  return out;
};
const iso = (d) => {
  const x = new Date();
  x.setUTCHours(11, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() - d);
  return x.toISOString();
};
const log = (d, subject, duration, type = "continue") => ({
  created_at: iso(d),
  subject,
  duration,
  habit_type: type,
  description: "",
  reason_category: null,
});

test.beforeEach(() => {
  who = { ok: true, userId: "u1" };
  fake = makeDb();
});

test("rejects non-GET and passes an access failure straight through", async () => {
  assert.equal((await call({}, "POST")).code, 405);
  who = { ok: false, status: 403, error: "Account not approved" };
  const r = await call();
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "Account not approved");
});

test("the dashboard payload uses the range, the saved goal and the account's join date", async () => {
  fake = makeDb({
    logs: [log(0, "Coding", 200)],
    settings: { daily_goal_min: 240, targets: {} },
  });
  const r = await call({ range: "7" });
  assert.equal(r.code, 200);
  assert.equal(r.body.range, 7);
  assert.equal(r.body.goal, 240);
  assert.equal(r.body.period.build, 200);
  assert.equal(r.body.joined, "2026-06-01");
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("an unknown range falls back to 30 days", async () => {
  assert.equal((await call({ range: "5" })).body.range, 30);
  assert.equal((await call({ range: "abc" })).body.range, 30);
});

test("every read is scoped to the verified user", async () => {
  await call();
  for (const t of ["habit_logs", "lambert_settings", "user_access"])
    assert.ok(
      fake.seen.some(([n, c, v]) => n === t && c === "user_id" && v === "u1"),
      t,
    );
});

test("month mode returns calendar days and limits what it reads", async () => {
  fake = makeDb({ logs: [log(0, "Coding", 90)] });
  const month = new Date().toISOString().slice(0, 7);
  const r = await call({ month });
  assert.equal(r.code, 200);
  assert.ok(r.body.days && typeof r.body.days === "object");
  assert.ok(fake.seen.some(([n, c]) => n === "habit_logs" && c === "gte"));
  assert.ok(fake.seen.some(([n, c]) => n === "habit_logs" && c === "lt"));
  assert.equal((await call({ month: "2026-13" })).code, 400);
  assert.equal((await call({ month: "x" })).code, 400);
});

test("csv mode sends a downloadable file", async () => {
  fake = makeDb({ logs: [log(0, "Coding", 30)] });
  const r = await call({ format: "csv" });
  assert.equal(r.code, 200);
  assert.ok(r.headers["Content-Type"].startsWith("text/csv"));
  assert.ok(r.headers["Content-Disposition"].includes("attachment"));
  assert.ok(r.body.startsWith("date,time,subject,type,minutes,reason,note"));
});

test("a logs failure is a clear 500, not an empty page", async () => {
  fake = makeDb({ logsErr: { message: "boom" } });
  const r = await call();
  assert.equal(r.code, 500);
  assert.equal(r.body.error, "Couldn't load your logs");
});

test("missing settings and join date fall back to defaults", async () => {
  fake = makeDb({ settings: null, access: null });
  const r = await call();
  assert.equal(r.code, 200);
  assert.equal(r.body.goal, 180);
});
