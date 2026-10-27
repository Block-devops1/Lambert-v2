// api/_lib/checkAccess.js
// Shared by ai-chat.js and ai-brief.js. Both routes previously trusted
// whatever the client sent with zero identity check — meaning anyone
// with the endpoint URL could call Groq directly, unapproved or not.
// This closes that gap: every call must carry a valid session token,
// belong to an approved user_access row, and non-admins are capped and
// routed to the higher-quota model so they can never touch the admin's
// llama-3.3-70b-versatile daily limit.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const DAILY_CAP_NON_ADMIN = 150; // generous safety net, not a real-world limiter at small scale

async function checkAccess(authHeader) {
  const token = (authHeader || "").replace("Bearer ", "");
  if (!token) return { ok: false, status: 401, error: "Missing auth token" };

  const {
    data: { user },
    error: authErr,
  } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }

  const { data: access, error: accessErr } = await supabaseAdmin
    .from("user_access")
    .select(
      "status, is_admin, daily_msg_count, daily_msg_date, strictness_level, pending_strictness_level, strictness_change_effective_at",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (accessErr || !access) {
    return { ok: false, status: 403, error: "No access record found" };
  }
  if (access.status !== "approved") {
    return { ok: false, status: 403, error: "Account not approved" };
  }

  // ── Resolve any pending strictness decrease whose delay has elapsed ──
  let strictnessLevel = access.strictness_level ?? 1;
  if (
    access.pending_strictness_level &&
    access.strictness_change_effective_at &&
    new Date(access.strictness_change_effective_at) <= new Date()
  ) {
    strictnessLevel = access.pending_strictness_level;
    await supabaseAdmin
      .from("user_access")
      .update({
        strictness_level: strictnessLevel,
        pending_strictness_level: null,
        strictness_change_effective_at: null,
      })
      .eq("user_id", user.id);
  }

  // ── Admin: unlimited, always the higher-quality model ──
  if (access.is_admin) {
    return {
      ok: true,
      userId: user.id,
      isAdmin: true,
      model: "openai/gpt-oss-120b",
      strictnessLevel,
    };
  }

  // ── Non-admin: enforce daily cap, route to the high-quota model ──
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = access.daily_msg_date === today;
  const currentCount = sameDay ? access.daily_msg_count : 0;

  if (currentCount >= DAILY_CAP_NON_ADMIN) {
    return {
      ok: false,
      status: 429,
      error: "Daily message limit reached. Resets at midnight UTC.",
    };
  }

  await supabaseAdmin
    .from("user_access")
    .update({ daily_msg_count: currentCount + 1, daily_msg_date: today })
    .eq("user_id", user.id);

  return {
    ok: true,
    userId: user.id,
    isAdmin: false,
    model: "qwen/qwen3.8-27b",
    strictnessLevel,
  };
}

module.exports = { checkAccess };
