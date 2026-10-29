// Crisis backstop. Prompt rules alone are not a guarantee, so obvious crisis
// wording is caught in code and sent down a separate path: no coach persona, no
// user data, no tags and no actions. The phrase list is deliberately narrow and
// WILL miss some wording. It is a safety net, not a promise. A false alarm only
// costs one calm reply, so the list leans toward catching.

const CRISIS_PATTERNS = [
  /\bkill(?:ing)? my ?self\b/,
  /\bsuicid(?:e|al)\b/,
  /\bend(?:ing)? (?:my (?:own )?life|it all)\b/,
  /\btak(?:e|ing) my (?:own )?life\b/,
  /\b(?:want|wanna|wan|need)(?: to)? die\b/,
  /\b(?:don'?t|do not|dont|no) (?:want|wan|wanna) (?:to )?(?:live|be alive|go on)\b/,
  /\bbetter off dead\b/,
  /\b(?:hurt|hurting|harm|harming|cut|cutting) my ?self\b/,
  /\bself[- ]?harm/,
  /\bno reason to (?:live|go on)\b/,
  /\bbeat(?:s|ing)? me up\b/,
  /\bi (?:was|am|got|have been) (?:raped|abused|molested|sexually assaulted)\b/,
  /\bsexual(?:ly)? assault/,
  /\bi(?: a|')m (?:in danger|not safe)\b/,
];

function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/\s+/g, " ");
}

function looksLikeCrisis(text) {
  const t = normalise(text);
  return CRISIS_PATTERNS.some((re) => re.test(t));
}

// Used instead of the whole coach prompt. No data, no persona, no tags.
const CRISIS_PROMPT = `You are Lambert, replying to someone who may be in crisis or in danger. Drop the coaching persona completely for this reply.

- Be calm, warm and brief: 3 to 5 sentences of plain prose. No roasting, no critique, no goals, no habits, no numbers.
- Acknowledge what they said plainly. Do not argue with how they feel and do not lecture.
- Encourage them to contact local emergency services or someone they trust right now. If they may be in immediate danger, say so and tell them to call their local emergency number.
- Ask one gentle question: whether they are safe right now, or whether someone can be with them.
- You are not a doctor or therapist and you must not diagnose.
- You cannot contact anyone or send reminders. Never say or imply that you will.
- Do not use markdown, lists, headers or any <<...>> tags.`;

// Remove every <<KIND: ...>> tag (GOAL, REMEMBER, CHALLENGE, MISS, anything else).
function stripTags(text) {
  return String(text || "")
    .replace(/<<[A-Za-z_]+:[\s\S]*?>>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { looksLikeCrisis, CRISIS_PROMPT, stripTags, CRISIS_PATTERNS };
