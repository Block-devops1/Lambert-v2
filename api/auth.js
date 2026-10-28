// Verifies the caller's session and that they are allowed in, WITHOUT touching
// the daily message counter (checkAccess.js counts a message on every call, which
// is right for chat and wrong for loading a dashboard).
const { db } = require("./db.js");

async function getApprovedUser(authHeader) {
  const token = String(authHeader || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return { ok: false, status: 401, error: "Missing auth token" };

  const { data, error } = await db().auth.getUser(token);
  if (error || !data || !data.user) {
    return { ok: false, status: 401, error: "Invalid or expired session" };
  }

  const { data: access, error: accessErr } = await db()
    .from("user_access")
    .select("status, is_admin")
    .eq("user_id", data.user.id)
    .maybeSingle();

  // A failed lookup and a missing row are different problems; don't blur them.
  if (accessErr)
    return { ok: false, status: 500, error: "Access lookup failed" };
  if (!access)
    return { ok: false, status: 403, error: "No access record found" };
  if (access.status !== "approved" && !access.is_admin) {
    return { ok: false, status: 403, error: "Account not approved" };
  }
  return { ok: true, userId: data.user.id, isAdmin: !!access.is_admin };
}

module.exports = { getApprovedUser };
