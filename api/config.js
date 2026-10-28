module.exports = (req, res) => {
  const cfg = {
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
    DAILY_GOAL_MIN: Number(process.env.DAILY_GOAL_MIN) || 180,
  };
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send("window.LAMBERT = " + JSON.stringify(cfg) + ";");
};
