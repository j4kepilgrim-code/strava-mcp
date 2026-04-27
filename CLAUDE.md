# Strava MCP — Project Context

## What this is
A triathlon training assistant as an MCP server. Connects to Strava for real training data, stores state in Supabase (cloud Postgres), runs a deterministic plan engine, and exposes MCP tools so Claude acts as a conversational coach.

## Architecture
```
Claude Desktop (MCP client)
        │
        ▼
strava-mcp-server (stdio)
        ├── MCP Tools       — what Claude sees and calls
        ├── Plan Engine     — deterministic rules, no LLM, no DB calls (pure functions)
        ├── Supabase DB     — athlete profile, activities, plan state
        └── Strava Client   — OAuth2 + webhook sync
```

## Key decisions
- **Deterministic engine + LLM wrapper**: plan engine owns all scheduling logic. Claude interprets intent → calls named engine operations → summarises result. Claude never decides a workout.
- **Supabase (cloud Postgres)**: chosen for mobile/phone access and multi-user support. Each user supplies their own `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
- **All DB mutations write to `session_edits`**: append-only audit log. Never UPDATE or DELETE from this table.
- **Plan engine is pure**: no side effects, no DB calls. DB writes happen in the tool layer that calls engine functions.
- **stdio transport first**: Claude Desktop config. HTTP transport to be added later for phone/hosted access.

## Tech stack
| Concern | Package |
|---|---|
| MCP framework | `@modelcontextprotocol/sdk` |
| Database | `@supabase/supabase-js` |
| HTTP client | `axios` |
| Token storage | `dotenv` |
| TypeScript runtime | `tsx` (dev), `tsup` (build) |
| Webhook server | `express` |

## Critical rules
- TypeScript strict mode always on
- `rationale` field on `plan_sessions` must always be populated — it's how Claude explains sessions to the user
- Tool descriptions in `server.ts` must be precise and include parameter types
- Strava access tokens expire after 6 hours — always refresh before API calls
- Never commit `.env`

## Build sequence
1. Project scaffolding ✓
2. Database layer (Supabase schema + queries)
3. Strava OAuth
4. Strava client
5. Activity sync
6. Profile builder + CTL/ATL/TSB metrics
7. MCP server skeleton
8. Read tools (profile, history)
9. Plan engine (generation + operations)
10. Plan tools (create, reschedule)
11. Post-workout analysis
12. Webhook (real-time Strava sync)

## Claude Desktop config (add after step 7)
```json
{
  "mcpServers": {
    "strava-training": {
      "command": "npx",
      "args": ["tsx", "/Users/jakepilgrim/Documents/Projects/strava-mcp/src/index.ts"],
      "env": {
        "STRAVA_CLIENT_ID": "...",
        "STRAVA_CLIENT_SECRET": "...",
        "STRAVA_REDIRECT_URI": "http://localhost:3000/auth/callback",
        "SUPABASE_URL": "https://gfkdfcfyztozplhtutre.supabase.co",
        "SUPABASE_ANON_KEY": "..."
      }
    }
  }
}
```
