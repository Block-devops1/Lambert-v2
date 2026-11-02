# Lambert v2

A habit tracker with a built-in AI coach, performance analytics, and an admin user-approval system.

## Stack

- Frontend: HTML / CSS / Vanilla JS (served from `public/`)
- Backend: Vercel Serverless Functions (`api/`)
- Logic Engine: Node.js pure functions (`engine/`)
- Database & Auth: Supabase
- AI Provider: Groq API (`openai/gpt-oss-120b` & `qwen/qwen3.8-27b`)

## Environment Variables

Set these in your `.env` for local testing or in your Vercel Project Settings:

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key (public)
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (backend only)
- `GROQ_API_KEY` - Groq API key for the AI coach
- `DAILY_GOAL_MIN` - Default daily target build minutes (optional, defaults to 180)

## Folder Structure

- `public/` - Static web app files (dashboard, chat, analytics, admin portal, login)
- `api/` - Vercel serverless functions handling chat, state, and analytics requests
- `engine/` - Deterministic calculation engine for habit state, streaks, and metrics
- `supabase/` - SQL scripts and database triggers
- `tests/` - Test suite run via Node's native test runner

## Running Tests

To run the test suite:

```bash
node --test
```

## Database Tables Required

1. `user_access` - User approval status, message counts, admin flags
2. `habit_logs` - Habit entries and recorded misses
3. `lambert_settings` - User target configurations and daily goal minutes
4. `lambert_goals` - Active personal goals
5. `lambert_memories` - Facts remembered by Lambert
6. `lambert_conversations` - Saved chat history
7. `lambert_challenges` - Weekly challenges
8. `discontinued_habits` - Habits the user quit
