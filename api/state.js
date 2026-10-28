// GET /api/state — the one place dashboard numbers are computed.
// Reads the user's logs and settings on the server, runs the engine, and returns
// the state. The browser only draws it. The coach reads the same engine, so the
// dashboard and Lambert can't disagree.
const { db } = require("./_lib/db.js");
const { getApprovedUser } = require("./_lib/auth.js");
const E = require("../engine/engine.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year
const LOG_LIMIT = 2000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const who = await getApprovedUser(req.headers.authorization);
    if (!who.ok) return res.status(who.status).json({ error: who.error });

    const [logsR, settingsR, goalsR] = await Promise.all([
      db()
        .from("habit_logs")
        .select(
          "subject,duration,habit_type,description,reason_category,created_at",
        )
        .eq("user_id", who.userId)
        .order("created_at", { ascending: false })
        .limit(LOG_LIMIT),
      db()
        .from("lambert_settings")
        .select("daily_goal_min,targets")
        .eq("user_id", who.userId)
        .maybeSingle(),
      db()
        .from("lambert_goals")
        .select("goal")
        .eq("user_id", who.userId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    if (logsR.error)
      return res.status(500).json({ error: "Couldn't load your logs" });

    // Settings are optional: a missing row or table just means defaults.
    const warnings = [];
    if (settingsR.error) warnings.push("settings_unavailable");
    const settings = (!settingsR.error && settingsR.data) || {};

    const nowMs = Date.now();
    const localNow = new Date(nowMs + TZ_OFFSET_MIN * 60000);
    const state = E.buildState({
      logs: logsR.data || [],
      targets: E.sanitizeTargets(settings.targets),
      dailyGoalMin: settings.daily_goal_min,
      today: E.dayKey(nowMs, TZ_OFFSET_MIN),
      nowMs,
      tzOffsetMin: TZ_OFFSET_MIN,
      localHour: localNow.getUTCHours(),
    });

    const problems = E.validateState(state);
    if (problems.length) {
      console.error("state failed validation:", problems);
      return res.status(500).json({ error: "state_invalid" });
    }

    const goalRow = goalsR && goalsR.data && goalsR.data[0];
    return res.status(200).json({
      state,
      goalText: goalRow ? goalRow.goal : "",
      targets: E.sanitizeTargets(settings.targets),
      logsTruncated: (logsR.data || []).length >= LOG_LIMIT,
      warnings,
    });
  } catch (err) {
    console.error("api/state failed:", err);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};
