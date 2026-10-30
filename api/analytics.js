// GET /api/analytics        ?range=7|30|90   everything the Analytics page draws
// GET /api/analytics?month=YYYY-MM           one month for the calendar
// GET /api/analytics?format=csv              the user's logs as a CSV file
// Reads the user's own logs on the server and computes everything with the same
// code the tests cover, so the page only draws what it is given.
const { db } = require("./_lib/db.js");
const { getApprovedUser } = require("./_lib/auth.js");
const E = require("../engine/engine.js");
const A = require("../engine/analytics.js");

const TZ_OFFSET_MIN = 60; // Owerri / Lagos, UTC+1 all year
const RANGES = [7, 30, 90];
const LIMIT = 5000;
const COLS =
  "subject,duration,habit_type,description,reason_category,created_at";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const who = await getApprovedUser(req.headers.authorization);
    if (!who.ok) return res.status(who.status).json({ error: who.error });

    const q = req.query || {};
    const month = typeof q.month === "string" ? q.month : null;
    if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return res.status(400).json({ error: "month must look like 2026-10" });
    const csv = q.format === "csv";
    const range = RANGES.includes(Number(q.range)) ? Number(q.range) : 30;

    const today = E.dayKey(Date.now(), TZ_OFFSET_MIN);

    // Read only as far back as this view needs.
    let query = db()
      .from("habit_logs")
      .select(COLS)
      .eq("user_id", who.userId)
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (month) {
      query = query.gte(
        "created_at",
        A.addDays(month + "-01", -2) + "T00:00:00Z",
      );
      const next = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1))
        .toISOString()
        .slice(0, 10);
      query = query.lt("created_at", A.addDays(next, 2) + "T00:00:00Z");
    } else if (!csv) {
      query = query.gte(
        "created_at",
        A.addDays(today, -(Math.max(2 * range, 56) + 2)) + "T00:00:00Z",
      );
    }

    const [logsR, settingsR, accessR] = await Promise.all([
      query,
      db()
        .from("lambert_settings")
        .select("daily_goal_min,targets")
        .eq("user_id", who.userId)
        .maybeSingle(),
      db()
        .from("user_access")
        .select("created_at")
        .eq("user_id", who.userId)
        .maybeSingle(),
    ]);
    if (logsR.error)
      return res.status(500).json({ error: "Couldn't load your logs" });
    const logs = logsR.data || [];

    if (csv) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="lambert-logs.csv"',
      );
      return res.status(200).send(A.toCsv(logs, TZ_OFFSET_MIN));
    }
    if (month)
      return res
        .status(200)
        .json({ days: A.calendarMonth(logs, month, TZ_OFFSET_MIN) });

    // Settings and the join date are optional: defaults keep the page working.
    const settings = (!settingsR.error && settingsR.data) || {};
    const joinedMs =
      !accessR.error && accessR.data
        ? Date.parse(accessR.data.created_at)
        : NaN;
    const joined = Number.isFinite(joinedMs)
      ? A.dayOf(joinedMs, TZ_OFFSET_MIN)
      : today;

    return res.status(200).json(
      A.buildAnalytics({
        logs,
        today,
        tzOffsetMin: TZ_OFFSET_MIN,
        range,
        joined,
        goal: settings.daily_goal_min || 180,
        targets: E.sanitizeTargets ? E.sanitizeTargets(settings.targets) : {},
      }),
    );
  } catch (err) {
    console.error("api/analytics failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
