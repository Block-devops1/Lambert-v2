const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) =>
  fs.readFileSync(path.join(__dirname, "../public", f), "utf8");
const text = (f) =>
  read(f)
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ");
const privacy = text("privacy.html");
const terms = text("terms.html");

test("both legal pages exist, share a version, and link to each other and home", () => {
  for (const f of ["privacy.html", "terms.html"]) {
    const h = read(f);
    assert.ok(h.includes("Version 2026-10-29"), f);
    assert.ok(
      h.includes('href="/privacy.html"') &&
        h.includes('href="/terms.html"') &&
        h.includes('href="/"'),
      f,
    );
  }
});

test("the privacy policy says what the app and the AI prompt both promise", () => {
  for (const needle of [
    "not end-to-end encrypted",
    "We can too: as the administrator we can access stored data, including chats",
    "does not retain customer data for AI requests by default",
    "up to 30 days",
    "held in the United States",
    "does not use customer data to train models",
    "We do not sell your data",
    "Nigeria Data Protection Act 2023",
    "Nigeria Data Protection Commission",
    "within 72 hours",
    "aged 18 or older",
    "within 30 days",
    "Google Fonts and jsDelivr",
    "console.groq.com/docs/your-data",
  ])
    assert.ok(privacy.includes(needle), needle);
});

test("the terms cover the AI limits, acceptable use, free-service caveat, liability and governing law", () => {
  for (const needle of [
    "You must be 18 or older",
    "blunt by design",
    "not a doctor, therapist, lawyer or financial adviser",
    "Lambert cannot contact anyone, send reminders",
    "Do not try to make the AI ignore its rules",
    "we do not promise any level of uptime",
    "Nigerian consumer protection law",
    "laws of the Federal Republic of Nigeria",
  ])
    assert.ok(terms.includes(needle), needle);
});

test("placeholders are marked, and only the known four exist", () => {
  const found = new Set(
    [
      ...(read("privacy.html") + read("terms.html")).matchAll(/\[\[(.*?)\]\]/g),
    ].map((m) => m[1]),
  );
  assert.deepEqual([...found].sort(), [
    "CONTACT EMAIL",
    "OWNER NAME",
    "STATE",
    "SUPABASE REGION",
  ]);
});

test("sign-up requires consent and records the terms version; legal links are everywhere", () => {
  const login = read("login.html");
  assert.ok(
    login.includes('id="consent"') &&
      login.includes("I am 18 or older and I agree"),
  );
  assert.ok(
    login.includes('href="/terms.html"') &&
      login.includes('href="/privacy.html"'),
  );
  assert.ok(
    login.includes("terms_version: TERMS_VERSION") &&
      login.includes('TERMS_VERSION = "2026-10-29"'),
  );
  assert.ok(read("index.html").includes('href="/privacy.html"'));
  assert.ok(read("settings.html").includes('href="/privacy.html"'));
});
