// The model asks for a miss to be recorded with <<MISS: habit | category | note>>.
// Code decides whether that request is real. Invalid or invented requests are
// dropped silently; the tag is always stripped from the text the user sees.

const { REASON_CATEGORIES, normText } = require("../../engine/engine.js");

const MISS_TAG =
  /<<MISS:\s*([^|>]+?)\s*\|\s*([^|>]+?)\s*(?:\|\s*([^>]*?))?\s*>>/g;

function extractActions(reply, state) {
  // Only build habits that have not been logged today can take a miss.
  const allowed = new Set(
    (state.habits || [])
      .filter((h) => h.direction === "build" && !h.loggedToday)
      .map((h) => h.subject),
  );
  const seen = new Set();
  const actions = [];

  const text = String(reply || "")
    .replace(MISS_TAG, (_, subject, category, note) => {
      const s = normText(subject);
      const c = String(category)
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
      if (allowed.has(s) && REASON_CATEGORIES.includes(c) && !seen.has(s)) {
        seen.add(s);
        actions.push({
          type: "miss",
          subject: s,
          category: c,
          note: String(note || "").trim(),
        });
      }
      return "";
    })
    .replace(/^\s+/, "");

  return { reply: text, actions };
}

module.exports = { extractActions };
