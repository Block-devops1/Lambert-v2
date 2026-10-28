// Pure helpers for coach.html. Kept separate so they can be unit-tested in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CoachLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var TAGS = /<<(GOAL|REMEMBER|CHALLENGE):\s*([\s\S]*?)>>/g;

  // Lambert marks things to save with <<GOAL: ...>>, <<REMEMBER: ...>> and
  // <<CHALLENGE: ...>>. Pull them out of the visible text and return them.
  function pullTags(text) {
    var tags = [];
    var clean = String(text || "")
      .replace(TAGS, function (_, kind, value) {
        var v = value.trim();
        if (v) tags.push({ kind: kind, value: v });
        return "";
      })
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { clean: clean, tags: tags };
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Monday of the week containing `date`, as YYYY-MM-DD in the date's local time.
  function weekStartKey(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    );
  }

  function label(category) {
    return String(category).replace(/_/g, " ");
  }

  // The habit_logs row that records a validated MISS action from /api/ai-chat.
  function missRow(action, uid, nowIso) {
    return {
      user_id: uid,
      subject: action.subject,
      duration: 0,
      habit_type: "continue",
      description: action.note || label(action.category),
      reason_category: action.category,
      created_at: nowIso,
    };
  }

  return {
    pullTags: pullTags,
    weekStartKey: weekStartKey,
    missRow: missRow,
    label: label,
  };
});
