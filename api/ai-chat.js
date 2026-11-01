// api/ai-chat.js - Vercel Serverless Function (Lambert v2)
//
// Flow: verify access -> (crisis wording? take the safe path) -> read the user's
// logs, settings, goals, memories, chat history and weekly challenge from the
// database ON THE SERVER -> build state with the engine (code, not the model) ->
// refuse to continue if the state is corrupt -> render the prompt -> call Groq ->
// validate any <<MISS:>> tag -> return reply + actions.
// Nothing the browser sends is trusted for data. The browser sends only the message.

const { checkAccess } = require("./_lib/checkAccess.js");
const { db } = require("./_lib/db.js");
const E = require("../engine/engine.js");
const { buildSystemPrompt } = require("./_lib/prompt.js");
const { extractActions } = require("./_lib/actions.js");
const {
  looksLikeCrisis,
  CRISIS_PROMPT,
  CRISIS_RESOURCES_TEXT,
  stripTags,
} = require("./_lib/safety.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year
const MAX_MESSAGE_CHARS = 2000;
const HISTORY_FOR_AI = 12; // messages the model sees; the chat screen can show more
const HISTORY_CLIP = 600; // characters kept per old message, to protect the token budget
const MEMORY_LIMIT = 40;
const CRISIS_HISTORY = 6;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
const validTurn = (m) =>
  m &&
  (m.role === "user" || m.role === "assistant") &&
  typeof m.content === "string" &&
  m.content.trim();

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // -- Verify identity, approval, daily cap, and model routing --
  const access = await checkAccess(req.headers.authorization);
  if (!access.ok) {
    return res
      .status(access.status)
      .json({ error: access.error, reply: access.error });
  }

  const { message, history: browserHistory } = req.body || {};

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

  // Crisis wording: skip the coach entirely. No database read (it must not be
  // able to fail this path), no persona, and no tags or actions in the reply.
  const crisis = looksLikeCrisis(message);
  let state = null;
  let systemPrompt = CRISIS_PROMPT;
  let history = [];

  if (crisis) {
    // Only conversation context, nothing that feeds numbers or actions.
    history = (Array.isArray(browserHistory) ? browserHistory : [])
      .filter(validTurn)
      .slice(-CRISIS_HISTORY)
      .map((m) => ({ role: m.role, content: clip(m.content, HISTORY_CLIP) }));
  } else {
    // -- Data: read on the server, always scoped to the verified user --
    const nowMs = Date.now();
    const localNow = new Date(nowMs + TZ_OFFSET_MIN * 60000);
    const today = E.dayKey(nowMs, TZ_OFFSET_MIN);
    const uid = access.userId;

    let logsR, settingsR, goalsR, memoriesR, convR, challengeR, discR;
    try {
      [logsR, settingsR, goalsR, memoriesR, convR, challengeR, discR] =
        await Promise.all([
          db()
            .from("habit_logs")
            .select(
              "subject,duration,habit_type,description,reason_category,created_at",
            )
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(2000),
          db()
            .from("lambert_settings")
            .select("daily_goal_min,targets")
            .eq("user_id", uid)
            .maybeSingle(),
          db()
            .from("lambert_goals")
            .select("goal")
            .eq("user_id", uid)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(10),
          db()
            .from("lambert_memories")
            .select("memory")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(MEMORY_LIMIT),
          db()
            .from("lambert_conversations")
            .select("role,content")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(HISTORY_FOR_AI),
          db()
            .from("lambert_challenges")
            .select("challenge")
            .eq("user_id", uid)
            .eq("week_start", E.mondayOf(today))
            .order("created_at", { ascending: false })
            .limit(1),
          // v2 may not have this table yet; the chat must still work without it.
          db().from("discontinued_habits").select("subject").eq("user_id", uid),
        ]);
      if (logsR.error) throw logsR.error; // logs are the one thing we cannot guess
    } catch (err) {
      console.error("Lambert could not load user data:", err);
      return res.status(500).json({
        error: "data_unavailable",
        reply:
          "Lambert couldn't load your logs, so he's staying quiet instead of guessing. Try again in a moment.",
      });
    }

    // Everything except the logs is optional: a failed read means "none".
    const rows = (r) => (r && !r.error && Array.isArray(r.data) ? r.data : []);
    const settings = settingsR && !settingsR.error ? settingsR.data : null;
    const goals = rows(goalsR)
      .map((g) => (g && typeof g.goal === "string" ? g.goal.trim() : ""))
      .filter(Boolean)
      .map((goal) => ({ goal }));
    const memories = rows(memoriesR)
      .map((m) => (m && typeof m.memory === "string" ? m.memory.trim() : ""))
      .filter(Boolean)
      .reverse() // oldest first
      .map((memory) => ({ memory }));
    history = rows(convR)
      .filter(validTurn)
      .map((m) => ({ role: m.role, content: clip(m.content, HISTORY_CLIP) }))
      .reverse(); // the query is newest first; the model wants oldest first
    const challengeRow = rows(challengeR)[0];
    const weeklyChallenge =
      challengeRow && typeof challengeRow.challenge === "string"
        ? challengeRow.challenge
        : null;
    const discontinued = rows(discR)
      .map((d) => d && d.subject)
      .filter(Boolean);

    // -- State: computed by code from the logs --
    state = E.buildState({
      logs: rows(logsR),
      targets: E.sanitizeTargets(settings && settings.targets),
      dailyGoalMin: settings ? settings.daily_goal_min : undefined,
      discontinued,
      today,
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
      goals,
      memories,
      weeklyChallenge,
      strictnessLevel: access.strictnessLevel,
      escalationLevel: 0, // no browser-sent value; a code-computed level can replace this
      localTime: localNow.toISOString().slice(11, 16),
    });
  }

  const messages = [...history, { role: "user", content: message }];

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

      // In the crisis path every tag is stripped, no action can fire, and the
      // emergency contacts are added by code (the model never writes numbers).
      const { reply, actions } = crisis
        ? {
            reply: stripTags(raw) + "\n\n" + CRISIS_RESOURCES_TEXT,
            actions: [],
          }
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

  // Provider detail (model names, quota messages) is for the admin only.
  const detail = access.isAdmin
    ? ` Real error: ${lastError?.message || "unknown"}`
    : "";
  const isRateLimit = lastError?.status === 429;
  const isModelNotFound = lastError?.status === 404;
  return res.status(500).json({
    reply: isRateLimit
      ? "Lambert is resting - the AI service is rate limiting. Try again in 30 seconds."
      : isModelNotFound
        ? `Lambert can't reach his model right now.${detail}`
        : `Lambert hit an unexpected error.${detail}`,
  });
};
