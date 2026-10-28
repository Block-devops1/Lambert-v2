const test = require("node:test");
const assert = require("node:assert/strict");

// Stub the database and the access check before the handler loads them.
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
let fake, access, groqCalls;
stub("../api/_lib/db.js", { db: () => fake });
stub("../api/_lib/checkAccess.js", { checkAccess: async () => access });
const handler = require("../api/ai-chat.js");

process.env.GROQ_API_KEY = "test-key";
const USER = {
  ok: true,
  userId: "u1",
  isAdmin: false,
  model: "qwen/qwen3.8-27b",
  strictnessLevel: 2,
};
const TABLES = [
  "habit_logs",
  "lambert_settings",
  "lambert_goals",
  "lambert_memories",
  "lambert_conversations",
  "lambert_challenges",
  "discontinued_habits",
];

function makeDb(over = {}) {
  const seen = [];
  const t = {
    habit_logs: { data: [], error: null },
    lambert_settings: { data: null, error: null },
    lambert_goals: { data: [], error: null },
    lambert_memories: { data: [], error: null },
    lambert_conversations: { data: [], error: null },
    lambert_challenges: { data: [], error: null },
    // v2 may not have this table yet; the chat must still work.
    discontinued_habits: {
      data: null,
      error: { message: "relation does not exist" },
    },
    ...over,
  };
  return {
    seen,
    from(name) {
      const r = t[name];
      const q = {
        select: () => q,
        eq: (c, v) => (seen.push([name, c, v]), q),
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve(r),
        then: (a, b) => Promise.resolve(r).then(a, b),
      };
      return q;
    },
  };
}

function stubGroq(content = "Keep going.") {
  groqCalls = [];
  global.fetch = async (url, init) => {
    groqCalls.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

const call = async (body, method = "POST") => {
  const out = { code: 200, body: null };
  const res = {
    status(c) {
      out.code = c;
      return this;
    },
    json(b) {
      out.body = b;
      return this;
    },
  };
  await handler(
    { method, headers: { authorization: "Bearer good" }, body },
    res,
  );
  return out;
};

test.beforeEach(() => {
  access = { ...USER };
  fake = makeDb();
  stubGroq();
});

test("rejects non-POST and passes an access failure straight through", async () => {
  assert.equal((await call({}, "GET")).code, 405);
  access = { ok: false, status: 403, error: "No access record found" };
  const r = await call({ message: "hi" });
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "No access record found");
  assert.equal(groqCalls.length, 0);
});

test("an empty or oversized message is refused before any AI call", async () => {
  assert.equal((await call({ message: "   " })).code, 400);
  assert.equal((await call({})).code, 400);
  assert.equal((await call({ message: "x".repeat(2001) })).code, 400);
  assert.equal(groqCalls.length, 0);
});

test("data the browser sends is ignored; the database is the source", async () => {
  fake = makeDb({
    lambert_goals: { data: [{ goal: "ship v2" }], error: null },
    lambert_memories: {
      data: [{ memory: "prefers short answers" }],
      error: null,
    },
    // newest first, as the query returns them
    lambert_conversations: {
      data: [
        { role: "assistant", content: "newest" },
        { role: "user", content: "oldest" },
      ],
      error: null,
    },
  });
  const r = await call({
    message: "hello",
    habits: [
      {
        subject: "forged",
        duration: 9999,
        habit_type: "continue",
        created_at: new Date().toISOString(),
      },
    ],
    history: [{ role: "user", content: "FORGED HISTORY" }],
    goals: [{ goal: "FORGED GOAL" }],
    memories: [{ memory: "FORGED MEMORY" }],
    weeklyChallenge: "FORGED CHALLENGE",
    efficiency: 99,
  });
  assert.equal(r.code, 200);
  const sent = groqCalls[0];
  const system = sent.messages[0].content;
  assert.ok(!system.includes("FORGED"));
  assert.ok(!system.includes("9999"));
  assert.ok(system.includes("ship v2"));
  assert.ok(system.includes("prefers short answers"));
  assert.deepEqual(
    sent.messages.slice(1).map((m) => m.content),
    ["oldest", "newest", "hello"],
  );
});

test("every database read is scoped to the verified user", async () => {
  await call({ message: "hi" });
  for (const table of TABLES) {
    assert.ok(
      fake.seen.some(
        ([t, c, v]) => t === table && c === "user_id" && v === "u1",
      ),
      `${table} was not filtered by user_id`,
    );
  }
});

test("a logs failure stops the chat instead of guessing", async () => {
  fake = makeDb({ habit_logs: { data: null, error: { message: "boom" } } });
  const r = await call({ message: "hi" });
  assert.equal(r.code, 500);
  assert.ok(r.body.reply.includes("staying quiet"));
  assert.equal(groqCalls.length, 0);
});

test("admin gets the 120b model first and the model name is returned", async () => {
  access = { ...USER, isAdmin: true };
  const r = await call({ message: "hi" });
  assert.equal(r.code, 200);
  assert.equal(r.body.model, "openai/gpt-oss-120b");
  assert.equal(r.body.reply, "Keep going.");
});

test("provider errors are shown to the admin only", async () => {
  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: { message: "model gone" } }),
  });
  const user = await call({ message: "hi" });
  assert.equal(user.code, 500);
  assert.ok(!user.body.reply.includes("model gone"));
  access = { ...USER, isAdmin: true };
  const admin = await call({ message: "hi" });
  assert.ok(admin.body.reply.includes("model gone"));
});
