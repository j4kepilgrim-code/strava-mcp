# Strava MCP — Project Context

## What this is
A running training assistant as an MCP server. Connects to Strava for real training data, stores state in a local SQLite database, runs a deterministic plan engine, and exposes MCP tools so Claude acts as a conversational coach.

## Architecture
```
Claude Desktop (MCP client)
        │
        ▼
strava-mcp-server (stdio)
        ├── MCP Tools       — what Claude sees and calls
        ├── Plan Engine     — deterministic rules, no LLM, no DB calls (pure functions)
        ├── SQLite DB       — stored at ~/.strava-mcp/db.sqlite
        └── Strava Client   — OAuth2 + webhook sync
```

## Key decisions
- **Deterministic engine + LLM wrapper**: plan engine owns all scheduling logic. Claude interprets intent → calls named engine operations → summarises result. Claude never decides a workout.
- **SQLite**: local file at `~/.strava-mcp/db.sqlite`. Zero setup for users — no accounts, no keys, no pausing. Created automatically on first run.
- **All DB mutations write to `session_edits`**: append-only audit log. Never UPDATE or DELETE from this table.
- **Plan engine is pure**: no side effects, no DB calls. DB writes happen in the tool layer that calls engine functions.
- **stdio transport**: Claude Desktop spawns the process directly. Webhook runs alongside on port 3000.

## Tech stack
| Concern | Package |
|---|---|
| MCP framework | `@modelcontextprotocol/sdk` |
| Database | `better-sqlite3` |
| HTTP client | `axios` |
| Token storage | `dotenv` + `.strava-tokens.json` |
| TypeScript runtime | `tsx` (dev), `tsup` (build) |
| Webhook server | `express` |

## Critical rules
- TypeScript strict mode always on
- `rationale` field on `plan_sessions` must always be populated — it's how Claude explains sessions to the user
- Tool descriptions in `server.ts` must be precise and include parameter types
- Strava access tokens expire after 6 hours — always refresh before API calls
- Never commit `.env` or `.strava-tokens.json`

## Claude Desktop config
```json
{
  "mcpServers": {
    "strava-training": {
      "command": "npx",
      "args": ["tsx", "/path/to/strava-mcp/src/index.ts"],
      "env": {
        "STRAVA_CLIENT_ID": "...",
        "STRAVA_CLIENT_SECRET": "...",
        "STRAVA_REDIRECT_URI": "http://localhost:3000/auth/callback"
      }
    }
  }
}
```
