# Lambert v2 — Project Blueprint

## Overview

Lambert v2 is a habit tracker with an AI performance coach. The engine computes habit streaks, weekly targets, and performance metrics deterministically, while the AI layer handles chat responses and coaching without math errors or hallucinations.

---

## Folder Breakdown

### `public/`

Static web frontend served directly by Vercel:

- `index.html` — Landing page
- `app.html` — Main habit logging dashboard
- `coach.html` — AI coach chat UI
- `analytics.html` — Long-term charts and analytics UI
- `admin.html` — User access approval portal
- `login.html` — Supabase authentication page
- `settings.html` — Habit targets and profile settings
- `nav.js` — Navigation bar logic
- `motion.css` / `motion.js` — Minimal UI animation system

### `api/`

Serverless API routes (Node.js running on Vercel):

- `ai-chat.js` — Core AI endpoint. Verifies user access, loads DB records, passes clean state to Groq, extracts tags/actions.
- `state.js` — Computes and returns habit state for the main dashboard.
- `analytics.js` — Computes analytics summaries, calendar data, and CSV exports.
- `config.js` — Serves safe public configuration (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) to the browser.
- `_lib/` — Server helpers (`auth.js`, `checkAccess.js`, `db.js`, `prompt.js`, `actions.js`, `safety.js`).

### `engine/`

Pure calculation core with zero database or network dependencies:

- `engine.js` — Calculates build/stop habit streaks, weekly strength, miss patterns, and state validation.
- `analytics.js` — Generates trend series, weak day highlights, and CSV formatting.

### `supabase/`

Database configuration and SQL utilities:

- `signup-trigger.sql` — Creates `user_access` rows automatically on new user signup.

### `tests/`

Automated test suite covering engine logic, safety checks, prompt rendering, and API handlers.

---

## Database Architecture

- **`user_access`**: `user_id` (PK), `email`, `status` (`pending`/`approved`), `is_admin`, `daily_msg_count`, `daily_msg_date`, `strictness_level`.
- **`habit_logs`**: `id`, `user_id`, `subject`, `duration`, `habit_type` (`continue`/`stop`), `description`, `reason_category`, `created_at`.
- **`lambert_settings`**: `user_id` (PK), `daily_goal_min`, `targets` (JSON object of habit frequency targets).
- **`lambert_goals`**: `id`, `user_id`, `goal`, `is_active`, `created_at`.
- **`lambert_memories`**: `id`, `user_id`, `memory`, `created_at`.
- **`lambert_conversations`**: `id`, `user_id`, `role`, `content`, `model`, `created_at`.
- **`lambert_challenges`**: `id`, `user_id`, `challenge`, `week_start`, `met`, `created_at`.
- **`discontinued_habits`**: `id`, `user_id`, `subject`, `created_at`.

---

## Deployment Steps

1. **Supabase**: Run `signup-trigger.sql` and set up all required database tables.
2. **Vercel Environment Variables**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GROQ_API_KEY`
3. **Deploy to Vercel**: Connect repository to Vercel and deploy. `vercel.json` routes static requests to `public/`.
4. **Admin Setup**: Set `is_admin = true` on your user in `user_access` via Supabase SQL Editor.

---

## Risks & Known Technical Notes

- Serverless memory and execution limits: `ai-chat.js` loads up to 2000 log rows to compute state server-side.
- Public client configs: `api/config.js` exposes the public Supabase Anon key and URL to frontend pages. Service role keys remain server-side only in `api/_lib/db.js` and `api/_lib/checkAccess.js`.
