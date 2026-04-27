# strava-mcp

An AI running coach that lives inside Claude Desktop. Connects to your Strava account, builds personalised training plans, and lets you have a real coaching conversation about your training.

**What it does:**
- Syncs your Strava history and computes fitness metrics (CTL/ATL/TSB)
- Builds structured training plans for 5k, 10k, half marathon, and marathon
- Generates real interval and threshold sessions with reps, distances, and pace targets
- Auto-estimates your threshold pace from your run history
- Detects when you're consistently outpacing or underperforming targets and suggests adjustments
- Lets you reschedule, skip, compress, or swap sessions in plain English

---

## Prerequisites

1. **A Strava account** with some run history
2. **A Strava API app** — create one at [strava.com/settings/api](https://www.strava.com/settings/api)
   - Set *Authorization Callback Domain* to `localhost`
   - Note your **Client ID** and **Client Secret**
3. **Claude Desktop** — [claude.ai/download](https://claude.ai/download)
4. **Node.js 18+**

---

## Installation

### Option A — npx (no clone needed)

Build the package first (until it's published to npm):

```bash
git clone https://github.com/j4kepilgrim-code/strava-mcp.git
cd strava-mcp
npm install && npm run build
```

Then point Claude Desktop at `dist/index.js` (see config below).

### Option B — global install from source

```bash
git clone https://github.com/j4kepilgrim-code/strava-mcp.git
cd strava-mcp
npm install && npm run build
npm link   # makes `strava-mcp` available as a command
```

---

## Claude Desktop configuration

Open Claude Desktop → Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "strava-training": {
      "command": "node",
      "args": ["/absolute/path/to/strava-mcp/dist/index.js"],
      "env": {
        "STRAVA_CLIENT_ID": "your_client_id",
        "STRAVA_CLIENT_SECRET": "your_client_secret",
        "STRAVA_REDIRECT_URI": "http://localhost:3000/auth/callback"
      }
    }
  }
}
```

Replace `/absolute/path/to/strava-mcp` with wherever you cloned the repo.

If you used `npm link`, you can use:
```json
"command": "strava-mcp",
"args": []
```

Restart Claude Desktop after saving.

---

## First run

1. **Connect Strava** — ask Claude: *"Connect my Strava account"*
   - Claude will call `get_oauth_url` and give you a link
   - Click it, authorise the app — you'll be redirected to a confirmation page automatically
   - No copy-pasting needed

2. **Sync your history** — ask Claude: *"Sync my activities"*
   - Downloads up to 5 years of history on first run
   - Auto-estimates your threshold pace from your recent runs
   - Computes your current CTL/ATL/TSB fitness snapshot

3. **Check your profile** — *"Show my athlete profile"*

4. **Get a plan recommendation** — *"I want to run a marathon on 2026-10-04, what do you recommend?"*

5. **Create a plan** — *"Create a marathon plan for 2026-10-04, 5 days a week, max 10 hours"*

6. **See this week** — *"What's on my plan this week?"*

---

## What the database stores

Everything is kept in a local SQLite file at `~/.strava-mcp/db.sqlite`. No accounts, no cloud, no API keys beyond Strava. Delete the file to start fresh.

---

## Available tools

Claude can call these directly — you don't need to know them, just talk naturally.

| Tool | What it does |
|------|-------------|
| `get_oauth_url` | Get the Strava authorisation URL |
| `sync_recent_activities` | Pull new activities from Strava, update fitness snapshot |
| `get_athlete_profile` | View thresholds, CTL/ATL/TSB, weekly volume |
| `get_fitness_trend` | CTL/ATL/TSB table over the last N weeks |
| `update_athlete_profile` | Set threshold pace, FTP, CSS, weight, VO2max |
| `recalibrate_plan` | Rebuild all remaining sessions with updated pace targets |
| `get_activity_history` | Recent activities with pace, HR, effort |
| `get_activity_detail` | Full detail on a single activity |
| `get_plan_recommendation` | Suggested days/hours based on current fitness |
| `create_plan` | Generate a new training plan (archives any existing one) |
| `get_current_plan` | This week's sessions with targets and structure |
| `get_week` | Any week's sessions by week number |
| `swap_sessions` | Swap two sessions between days |
| `move_session` | Move a session to a different date |
| `skip_session` | Mark a session as skipped with a reason |
| `compress_week` | Reduce a week's load (illness, travel, etc.) |
| `rescale_week` | Adjust a week's targets up or down by percentage |
| `analyse_workout` | Analyse a completed activity against its plan targets |
| `add_note` | Save a coaching note (how you're feeling, context for the plan) |

---

## Threshold pace

Your threshold pace drives all session targets — interval paces, easy zone, tempo zone, long run pace. It's auto-estimated from your Strava history on first sync using HR-zone analysis (or your fastest 15–60 min efforts if HR data is sparse).

To correct it: *"My threshold pace is 4:45/km"* → Claude calls `update_athlete_profile` then `recalibrate_plan`.

---

## Training plan structure

Plans follow a base → build → peak → taper progression scaled to your available weeks.

**Long run distances** are goal-specific, not hours-derived:

| Goal | Peak long run |
|------|--------------|
| 5k | 11km |
| 10k | 17km |
| Half marathon | 21km |
| Marathon | 34km |

**Interval sessions** are prescribed per goal and phase (e.g. marathon build = 6×1km at threshold+10s/km, 90s recovery jog). **Threshold sessions** split between 2×15min blocks (early build) and 25min continuous (late build/peak).

---

## Troubleshooting

**"Not authenticated"** — run sync or reconnect via `get_oauth_url`.

**Port 3000 already in use** — the OAuth callback server couldn't start. Kill whatever's on port 3000, or change `STRAVA_REDIRECT_URI` and the port in the code.

**Long run distances seem low** — check your threshold pace with `get_athlete_profile`. If it's unset or too slow, update it with `update_athlete_profile` and run `recalibrate_plan`.

**Plan doesn't reflect my fitness** — run `sync_recent_activities` to refresh your CTL snapshot, then `create_plan` again.
