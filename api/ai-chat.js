// api/ai-chat.js — Vercel Serverless Function (Lambert v2)
//
// Flow: verify access -> build state from the raw logs with the engine (code,
// not the model) -> refuse to continue if the state is corrupt -> render the
// prompt -> call Groq -> validate any <<MISS:>> tag -> return reply + actions.
// Logs and settings (daily goal, habit targets) are read from the database here
// on the server. Nothing the browser sends is trusted for numbers.

const { checkAccess } = require("./_lib/checkAccess.js");
const { db } = require("./_lib/db.js");
const E = require("../engine/engine.js");
const { buildSystemPrompt } = require("./_lib/prompt.js");
const { extractActions } = require("./_lib/actions.js");
const {
  looksLikeCrisis,
  CRISIS_PROMPT,
  stripTags,
} = require("./_lib/safety.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year

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

  // Crisis wording: skip the coach entirely. No data load (it must not be able
  // to fail this path), no persona, and no tags or actions in the reply.
  const crisis = looksLikeCrisis(message);
  let state = null;
  let systemPrompt = CRISIS_PROMPT;

  if (!crisis) {
    // ── Data: read on the server, never taken from the browser ──
    let logRows = [];
    let settings = null;
    try {
      const [logsR, settingsR] = await Promise.all([
        db()
          .from("habit_logs")
          .select(
            "subject,duration,habit_type,description,reason_category,created_at",
          )
          .eq("user_id", access.userId)
          .order("created_at", { ascending: false })
          .limit(2000),
        db()
          .from("lambert_settings")
          .select("daily_goal_min,targets")
          .eq("user_id", access.userId)
          .maybeSingle(),
      ]);
      if (logsR.error) throw logsR.error;
      logRows = logsR.data || [];
      if (!settingsR.error) settings = settingsR.data; // optional: defaults if missing
    } catch (err) {
      console.error("Lambert could not load user data:", err);
      return res.status(500).json({
        error: "data_unavailable",
        reply:
          "Lambert couldn't load your logs, so he's staying quiet instead of guessing. Try again in a moment.",
      });
    }

    // ── State: computed by code from the logs ──
    const nowMs = Date.now();
    const localNow = new Date(nowMs + TZ_OFFSET_MIN * 60000);
    state = E.buildState({
      logs: logRows,
      targets: E.sanitizeTargets(settings && settings.targets),
      dailyGoalMin: settings ? settings.daily_goal_min : undefined,
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

    systemPrompt = buildSystemPrompt({
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
  }

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

      // In the crisis path every tag is stripped and no action can fire.
      const { reply, actions } = crisis
        ? { reply: stripTags(raw), actions: [] }
        : extractActions(raw, state);
      console.log(`Lambert replied via ${model}; actions: ${actions.length}`);
      return res
        .status(200)
        .json({ reply, actions, model, ...(crisis ? { safeMode: true } : {}) });
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
