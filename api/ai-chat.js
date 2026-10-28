// api/ai-chat.js — Vercel Serverless Function (Lambert v2)
//
// The browser sends ONLY the user's message. Everything Lambert knows about the
// user (logs, targets, goals, memories, history, weekly challenge) is read here,
// from the database, using the user id from the verified token. Nothing the
// browser says about their data is trusted, so nobody can fake a streak.
//
// Flow: verify access -> load the user's data -> build state with the engine
// (code, not the model) -> refuse if the state is corrupt -> render the prompt ->
// call Groq -> validate any <<MISS:>> tag -> return reply + actions.

const { checkAccess } = require("./_lib/checkAccess.js");
const { db } = require("./_lib/db.js");
const E = require("../engine/engine.js");
const { buildSystemPrompt } = require("./_lib/prompt.js");
const { extractActions } = require("./_lib/actions.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year
const MAX_MESSAGE_CHARS = 2000;
const LOG_LIMIT = 2000;
const HISTORY_LIMIT = 20;
const MEMORY_LIMIT = 50;

// Monday (YYYY-MM-DD) of the current week in Lagos time; matches lambert_challenges.week_start.
function mondayKey(nowMs) {
  const d = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Everything about this user, read with the service client and scoped by user_id.
async function loadContext(userId, nowMs) {
  const c = db();
  const [logsR, settingsR, goalsR, memR, histR, chalR, discR] =
    await Promise.all([
      c
        .from("habit_logs")
        .select(
          "subject,duration,habit_type,description,reason_category,created_at",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(LOG_LIMIT),
      c
        .from("lambert_settings")
        .select("daily_goal_min,targets")
        .eq("user_id", userId)
        .maybeSingle(),
      c
        .from("lambert_goals")
        .select("goal")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("created_at", { ascending: false }),
      c
        .from("lambert_memories")
        .select("memory")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(MEMORY_LIMIT),
      c
        .from("lambert_conversations")
        .select("role,content")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT),
      c
        .from("lambert_challenges")
        .select("challenge")
        .eq("user_id", userId)
        .eq("week_start", mondayKey(nowMs))
        .order("created_at", { ascending: false })
        .limit(1),
      c.from("discontinued_habits").select("subject").eq("user_id", userId),
    ]);

  // Only the logs are essential. Anything else that fails just means "none yet".
  for (const [name, r] of [
    ["settings", settingsR],
    ["goals", goalsR],
    ["memories", memR],
    ["history", histR],
    ["challenge", chalR],
    ["discontinued", discR],
  ]) {
    if (r && r.error)
      console.warn(`ai-chat: ${name} unavailable:`, r.error.message);
  }
  const rows = (r) => (r && !r.error && Array.isArray(r.data) ? r.data : []);

  return {
    logsError: logsR.error || null,
    // Older saves wrote habit_type "build"; the engine calls build time "continue".
    logs: rows(logsR).map((l) =>
      l.habit_type === "build" ? { ...l, habit_type: "continue" } : l,
    ),
    settings: (!settingsR.error && settingsR.data) || {},
    goals: rows(goalsR),
    memories: rows(memR).reverse(), // oldest first
    history: rows(histR).reverse(), // oldest first
    weeklyChallenge: (rows(chalR)[0] || {}).challenge || null,
    discontinued: rows(discR)
      .map((d) => d.subject)
      .filter(Boolean),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ── Verify identity, approval, daily cap, and model routing ──
    const access = await checkAccess(req.headers.authorization);
    if (!access.ok) {
      return res
        .status(access.status)
        .json({ error: access.error, reply: access.error });
    }

    const { message, escalationLevel } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: "message is required", reply: "Empty message." });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: "message_too_long",
        reply: `That message is too long. Keep it under ${MAX_MESSAGE_CHARS} characters.`,
      });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GROQ_API_KEY not configured" });
    }

    // ── The user's data, read on the server ──
    const nowMs = Date.now();
    const localNow = new Date(nowMs + TZ_OFFSET_MIN * 60000);
    const ctx = await loadContext(access.userId, nowMs);
    if (ctx.logsError) {
      console.error("ai-chat: couldn't load logs:", ctx.logsError.message);
      return res.status(500).json({
        error: "logs_unavailable",
        reply:
          "Lambert couldn't load your logs, so he's staying quiet instead of guessing. Try again in a moment.",
      });
    }

    // ── State: computed by code from the logs ──
    const state = E.buildState({
      logs: ctx.logs,
      targets: E.sanitizeTargets(ctx.settings.targets),
      dailyGoalMin: ctx.settings.daily_goal_min,
      discontinued: ctx.discontinued,
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

    const escalation = Math.min(
      3,
      Math.max(0, parseInt(escalationLevel, 10) || 0),
    );
    const systemPrompt = buildSystemPrompt({
      state,
      goals: ctx.goals,
      memories: ctx.memories,
      weeklyChallenge: ctx.weeklyChallenge,
      strictnessLevel: access.strictnessLevel,
      escalationLevel: escalation,
      appMetrics: {},
      predictions: null,
      localTime: localNow.toISOString().slice(11, 16),
    });

    // Last 20 saved messages, valid roles only. (A rolling summary replaces this later.)
    const cleanHistory = ctx.history
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim(),
      )
      .map((m) => ({ role: m.role, content: m.content }));
    const messages = [...cleanHistory, { role: "user", content: message }];

    // Admin: gpt-oss-120b with qwen fallback (separate quota bucket).
    // Non-admins are routed by checkAccess. The model actually used is returned
    // in the response so a fallback is visible.
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
          console.warn(
            `Groq first attempt failed (${model}):`,
            firstErr.message,
          );
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

    // Raw provider errors are only shown to the admin.
    const detail = access.isAdmin
      ? ` Real error: ${lastError?.message || "unknown"}`
      : "";
    const isRateLimit = lastError?.status === 429;
    const isModelNotFound = lastError?.status === 404;
    return res.status(500).json({
      reply: isRateLimit
        ? "Lambert is resting. The AI provider is rate limiting. Try again in 30 seconds."
        : isModelNotFound
          ? "Lambert can't reach his model right now." + detail
          : "Lambert hit an unexpected error." + detail,
    });
  } catch (err) {
    console.error("api/ai-chat failed:", err);
    return res.status(500).json({
      error: "server_error",
      reply: "Lambert hit a server error. Try again in a moment.",
    });
  }
};
