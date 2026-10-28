// Shared server-side Supabase client (service key: bypasses row level security).
// Server code only. Never import this from anything served to the browser.
// Uses the same env var names as checkAccess.js.
const { createClient } = require("@supabase/supabase-js");

let client = null;

function db() {
  if (!client) {
    const url = process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      );
    }
    client = createClient(url, key);
  }
  return client;
}

module.exports = { db };
