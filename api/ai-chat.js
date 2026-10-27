// api/ai-chat.js — Vercel Serverless Function (Lambert v2)
//
// Flow: verify access -> build state from the raw logs with the engine (code,
// not the model) -> refuse to continue if the state is corrupt -> render the
// prompt -> call Groq -> validate any <<MISS:>> tag -> return reply + actions.
// Client-sent efficiency/streak numbers are NOT trusted for the streak anymore;
// the engine recomputes everything it can from the raw logs.

const { checkAccess } = require("./_lib/checkAccess.js");
const E = require("../engine/engine.js");
const { buildSystemPrompt } = require("./_lib/prompt.js");
const { extractActions } = require("./_lib/actions.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year

// EDIT THIS. Days per week you intend to do each BUILD habit. Until this is
// filled in, the engine has no targets: no habit gets an on_track/adjust/
// off_track status and Lambert never asks "why" about a missed habit.
// Subject names are matched case-insensitively.
const TARGETS = {
  // "bible reading": { daysPerWeek: 7 },
  // workout: { daysPerWeek: 4 },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Verify identity, approval, daily cap, and model routing ──
  const access = await checkAccess(req.headers.authorization);
  if (!access.ok) {
    return res
      .status(access.status)
      .json({ error: access.error, reply: access.error });
  }

  const {
    message,
    history, // [{role, content}] from lambert_conversations
    habits, // raw habit_logs rows
    efficiency, // app-computed, passed through as "app-reported"
    consistency,
    winRate,
    goals, // lambert_goals rows
    memories, // lambert_memories rows
    discontinuedHabits, // [{subject}]
    weeklyChallenge, // string
    escalationLevel, // 0-3
    predictions, // app-computed object, passed through as "app-reported"
  } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res
      .status(400)
      .json({ error: "message is required", reply: "Empty message." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY not configured" });
  }

  // ── State: computed by code from the raw logs ──
  const nowMs = Date.now();
  const localNow = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  const state = E.buildState({
    logs: Array.isArray(habits) ? habits : [],
    targets: TARGETS,
    discontinued: Array.isArray(discontinuedHabits)
      ? discontinuedHabits.map((d) => d && d.subject).filter(Boolean)
      : [],
    today: E.dayKey(nowMs, TZ_OFFSET_MIN),
    nowMs,
    tzOffsetMin: TZ_OFFSET_MIN,
    localHour: localNow.getUTCHours(),
  });

  // A corrupt state means the model would be handed contradictory numbers.
  // Stay quiet instead of guessing.
  const problems = E.validateState(state);
  if (problems.length) {
    console.error("Lambert state failed validation:", problems);
    return res.status(500).json({
      error: "state_invalid",
      reply:
        "Lambert's data check failed, so he's staying quiet instead of guessing. Check the server logs.",
    });
  }

  const systemPrompt = buildSystemPrompt({
    state,
    goals: Array.isArray(goals) ? goals : [],
    memories: Array.isArray(memories) ? memories : [],
    weeklyChallenge,
    strictnessLevel: access.strictnessLevel,
    escalationLevel,
    appMetrics: { efficiency, consistency, winRate },
    predictions,
    localTime: localNow.toISOString().slice(11, 16),
  });

  // Last 20 messages, valid roles only. (A rolling summary replaces this cap later.)
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));
  const messages = [...cleanHistory, { role: "user", content: message }];

  // Admin: gpt-oss-120b with qwen fallback (separate quota bucket).
  // Non-admins are routed by checkAccess. The model actually used is returned
  // in the response so a silent fallback is visible.
  const models = access.isAdmin
    ? ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]
    : [access.model];

  const tryGroq = async (model) => {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          temperature: 0.4,
          // gpt-oss: low reasoning effort keeps chain-of-thought out of the reply.
          // qwen: reasoning off, Lambert needs a direct coaching reply.
          reasoning_effort: model.includes("qwen") ? "none" : "low",
          messages: [{ role: "system", content: systemPrompt }, ...messages],
        }),
      },
    );
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const err = new Error(
        `Groq ${response.status}: ${errBody?.error?.message || "unknown"}`,
      );
      err.status = response.status;
      throw err;
    }
    return response.json();
  };

  let lastError = null;

  for (const model of models) {
    try {
      let data;
      try {
        data = await tryGroq(model);
      } catch (firstErr) {
        lastError = firstErr;
        console.warn(`Groq first attempt failed (${model}):`, firstErr.message);
        // 404 = model not found/not allowed: permanent, don't retry.
        if (firstErr.status === 404) throw firstErr;
        await new Promise((r) => setTimeout(r, 1500));
        data = await tryGroq(model);
      }
      const raw = data.choices?.[0]?.message?.content || "";
      if (!raw.trim()) throw new Error(`Empty reply from ${model}`);

      const { reply, actions } = extractActions(raw, state);
      console.log(`Lambert replied via ${model}; actions: ${actions.length}`);
      return res.status(200).json({ reply, actions, model });
    } catch (err) {
      lastError = err;
      console.error(`Groq failed on model ${model}:`, err.message);
    }
  }

  const isRateLimit = lastError?.status === 429;
  const isModelNotFound = lastError?.status === 404;
  return res.status(500).json({
    reply: isRateLimit
      ? "Lambert is resting — Groq is rate limiting. Try again in 30 seconds."
      : isModelNotFound
        ? `Lambert can't reach his model right now (model not found/allowed on this Groq project). Real error: ${lastError?.message || "unknown"}`
        : `Lambert hit an unexpected error. Real error: ${lastError?.message || "unknown"}`,
  });
};
