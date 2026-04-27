import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAuthUrl, exchangeToken, loadTokens } from './strava/auth';
import { syncRecentActivities } from './tools/sync';
import { getAthleteProfile, getFitnessTrend, updateAthleteProfile, recalibratePlan } from './tools/profile';
import { getActivityHistory, getActivityDetail } from './tools/history';
import { getCurrentPlan, getWeekSessions, createPlan, getPlanRecommendationTool } from './tools/plan';
import { swapSessionsTool, moveSessionTool, skipSessionTool, compressWeekTool, rescaleWeekTool, addNoteTool } from './tools/reschedule';
import { analyseWorkout } from './tools/analysis';
import { log, logError } from './logger';

export const server = new Server(
  { name: 'strava-training', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function requireAuth(): void {
  if (!loadTokens()) {
    throw new UserError(
      'Not connected to Strava. Call get_oauth_url first, open the URL in your browser, then call exchange_token with the code from the redirect.'
    );
  }
}

function requireArgs(args: Record<string, unknown>, required: string[]): void {
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length > 0) {
    throw new UserError(`Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  }
}

class UserError extends Error {}

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_oauth_url',
      description: 'Returns the Strava OAuth URL. Open this in a browser to connect your Strava account. Must be called before any other tool will work.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'exchange_token',
      description: 'Completes Strava OAuth by exchanging the authorization code from the redirect URL. Call this after visiting the URL from get_oauth_url and approving access.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Authorization code from the Strava OAuth redirect URL (the "code" query parameter)' },
        },
        required: ['code'],
      },
    },
    {
      name: 'sync_recent_activities',
      description: 'Pulls activities from Strava into the database and updates CTL/ATL/TSB fitness metrics. First run fetches 5 years of history. Subsequent runs fetch only new activities since last sync. Call this before reading profile or history data.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_athlete_profile',
      description: 'Returns the athlete\'s current profile (FTP, threshold pace, CSS, weight) and latest fitness snapshot (CTL, ATL, TSB, weekly volume, sport split). Call sync_recent_activities first if data may be stale.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_fitness_trend',
      description: 'Returns CTL (chronic training load / fitness), ATL (acute training load / fatigue), and TSB (training stress balance / form) week by week over N weeks. Use to show the athlete their fitness trajectory or explain their current form.',
      inputSchema: {
        type: 'object',
        properties: {
          weeks: { type: 'number', description: 'Number of weeks of history to return (default 12, max 52)' },
        },
        required: [],
      },
    },
    {
      name: 'get_activity_history',
      description: 'Returns training activity aggregated by week — total distance, duration, elevation, and session count. Optionally filter by sport. Use to summarise training load or spot trends.',
      inputSchema: {
        type: 'object',
        properties: {
          weeks: { type: 'number', description: 'Number of weeks to return (default 8)' },
          sport: { type: 'string', description: 'Optional filter: Run | Ride | Swim | WeightTraining' },
        },
        required: [],
      },
    },
    {
      name: 'get_activity_detail',
      description: 'Returns full detail for a single activity including all sport-specific metrics (pace, power, cadence etc). Use when the athlete asks about a specific workout.',
      inputSchema: {
        type: 'object',
        properties: {
          activity_id: { type: 'string', description: 'The database activity ID' },
        },
        required: ['activity_id'],
      },
    },
    {
      name: 'get_current_plan',
      description: 'Returns the active training plan with this week\'s sessions, including targets and rationale for each session. Use whenever the athlete asks about their plan or what to do today.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_week',
      description: 'Returns all planned sessions for a specific week number in the active plan, with targets and rationale. Use when the athlete asks about a future or past week.',
      inputSchema: {
        type: 'object',
        properties: {
          week_number: { type: 'number', description: 'Week number in the plan (1 = first week of plan)' },
        },
        required: ['week_number'],
      },
    },
    {
      name: 'get_plan_recommendation',
      description: 'Reads the athlete\'s recent training history and current fitness to suggest plan parameters (days/week, max hours). Call this before create_plan so Claude can propose intelligent defaults rather than asking the athlete to fill in numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_type: { type: 'string', description: 'One of: 5k | 10k | half_marathon | marathon' },
          goal_date: { type: 'string', description: 'Target event date in ISO 8601 format (e.g. 2025-09-14)' },
        },
        required: ['goal_type', 'goal_date'],
      },
    },
    {
      name: 'create_plan',
      description: 'Generates a full training plan from scratch based on the athlete\'s goal, available training time, and current fitness. Archives any existing active plan. Call get_plan_recommendation first to suggest parameters, then get_athlete_profile to check fitness.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_type: { type: 'string', description: 'One of: 5k | 10k | half_marathon | marathon' },
          goal_date: { type: 'string', description: 'Target event date in ISO 8601 format (e.g. 2025-09-14)' },
          goal_description: { type: 'string', description: 'Free text goal e.g. "Sub 1:45 half marathon"' },
          available_days: { type: 'number', description: 'Number of training days available per week (1–7)' },
          max_hours_per_week: { type: 'number', description: 'Maximum total training hours per week' },
        },
        required: ['goal_type', 'goal_date', 'available_days', 'max_hours_per_week'],
      },
    },
    {
      name: 'update_athlete_profile',
      description: 'Updates the athlete\'s training thresholds (threshold pace, FTP, CSS, weight, VO2max). Call this when the athlete tells you their threshold pace or when analysis of recent workouts suggests their fitness has changed. After updating, call recalibrate_plan to apply new targets.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold_pace: { type: 'string', description: 'Threshold running pace in MM:SS format (e.g. "4:45" = 4:45/km)' },
          ftp_watts: { type: 'number', description: 'Functional threshold power in watts (cycling)' },
          css_per_100m: { type: 'string', description: 'Critical swim speed per 100m in MM:SS format' },
          weight_kg: { type: 'number', description: 'Athlete weight in kilograms' },
          vo2max_estimate: { type: 'number', description: 'Estimated VO2max' },
        },
        required: [],
      },
    },
    {
      name: 'recalibrate_plan',
      description: 'Recalculates pace targets for all remaining planned sessions using the athlete\'s current threshold pace. Call this after update_athlete_profile when the athlete\'s fitness has measurably changed — either improving (faster targets) or regressing (easier targets).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'swap_sessions',
      description: 'Swaps the scheduled dates of two sessions. Use when the athlete wants to rearrange two sessions between days. Validates that the swap does not create back-to-back hard sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id_a: { type: 'string', description: 'ID of the first session' },
          session_id_b: { type: 'string', description: 'ID of the second session' },
        },
        required: ['session_id_a', 'session_id_b'],
      },
    },
    {
      name: 'move_session',
      description: 'Moves a single session to a new date. Use when the athlete wants to shift one session without swapping. Validates training constraints.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ID of the session to move' },
          new_date: { type: 'string', description: 'New scheduled date in ISO 8601 format (e.g. 2025-06-03)' },
        },
        required: ['session_id', 'new_date'],
      },
    },
    {
      name: 'skip_session',
      description: 'Marks a session as skipped. Use when the athlete cannot complete a session due to illness, travel, injury, or other life events.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ID of the session to skip' },
          reason: { type: 'string', description: 'Optional reason (e.g. "illness", "travel", "work")' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'compress_week',
      description: 'Reduces a training week to a maximum number of sessions. Drops optional sessions first, then standard sessions. Key sessions are always protected. Use when the athlete says they have a busy week.',
      inputSchema: {
        type: 'object',
        properties: {
          week_number: { type: 'number', description: 'Week number in the plan to compress' },
          max_sessions: { type: 'number', description: 'Maximum number of sessions to keep that week' },
        },
        required: ['week_number', 'max_sessions'],
      },
    },
    {
      name: 'rescale_week',
      description: 'Scales all session targets in a week by a load factor. Use 0.6–0.7 for a recovery week, 1.1–1.2 to add load. All target distances and durations are multiplied by the factor.',
      inputSchema: {
        type: 'object',
        properties: {
          week_number: { type: 'number', description: 'Week number in the plan to rescale' },
          load_factor: { type: 'number', description: 'Scaling factor: 0.7 = 70% load (recovery week), 1.1 = 110% (extra load)' },
        },
        required: ['week_number', 'load_factor'],
      },
    },
    {
      name: 'analyse_workout',
      description: 'Compares a completed Strava activity against the planned session target and generates personalised coaching feedback. Use after the athlete completes a workout and asks "how did that go?"',
      inputSchema: {
        type: 'object',
        properties: {
          strava_activity_id: { type: 'string', description: 'The Strava activity ID (visible in the Strava URL)' },
        },
        required: ['strava_activity_id'],
      },
    },
    {
      name: 'add_note',
      description: 'Logs a coaching note against a date. Use to record injuries, illness, race results, travel, or any athlete context the plan should account for.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The note content' },
          date: { type: 'string', description: 'Date for the note in ISO 8601 format (defaults to today)' },
        },
        required: ['note'],
      },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  log(`Tool called: ${name}`);

  try {
    switch (name) {
      case 'get_oauth_url': {
        const url = getAuthUrl();
        return ok(`Open this URL in your browser to connect Strava:\n\n${url}\n\nAfter approving, copy the "code" parameter from the redirect URL and call exchange_token.`);
      }

      case 'exchange_token': {
        requireArgs(args, ['code']);
        const tokens = await exchangeToken(args['code'] as string);
        return ok(`Strava connected successfully. Athlete Strava ID: ${tokens.athlete_id}.\n\nNext step: call sync_recent_activities to pull your training history.`);
      }

      case 'sync_recent_activities': {
        requireAuth();
        const result = await syncRecentActivities();
        return ok(result.message);
      }

      case 'get_athlete_profile': {
        requireAuth();
        const profile = await getAthleteProfile();
        return ok(profile);
      }

      case 'get_fitness_trend': {
        requireAuth();
        const weeks = typeof args['weeks'] === 'number' ? args['weeks'] : 12;
        const trend = await getFitnessTrend(weeks);
        return ok(trend);
      }

      case 'get_activity_history': {
        requireAuth();
        const weeks = typeof args['weeks'] === 'number' ? args['weeks'] : 8;
        const sport = typeof args['sport'] === 'string' ? args['sport'] : undefined;
        const history = await getActivityHistory(weeks, sport);
        return ok(history);
      }

      case 'get_activity_detail': {
        requireAuth();
        requireArgs(args, ['activity_id']);
        const detail = await getActivityDetail(args['activity_id'] as string);
        return ok(detail);
      }

      case 'get_current_plan': {
        requireAuth();
        return ok(await getCurrentPlan());
      }

      case 'get_week': {
        requireAuth();
        requireArgs(args, ['week_number']);
        return ok(await getWeekSessions(args['week_number'] as number));
      }

      case 'get_plan_recommendation': {
        requireAuth();
        requireArgs(args, ['goal_type', 'goal_date']);
        return ok(await getPlanRecommendationTool(args['goal_type'] as string, args['goal_date'] as string));
      }

      case 'create_plan': {
        requireAuth();
        requireArgs(args, ['goal_type', 'goal_date', 'available_days', 'max_hours_per_week']);
        return ok(await createPlan({
          goal_type: args['goal_type'] as string,
          goal_date: args['goal_date'] as string,
          goal_description: typeof args['goal_description'] === 'string' ? args['goal_description'] : undefined,
          available_days: args['available_days'] as number,
          max_hours_per_week: args['max_hours_per_week'] as number,
        }));
      }

      case 'update_athlete_profile': {
        requireAuth();
        return ok(await updateAthleteProfile({
          threshold_pace: typeof args['threshold_pace'] === 'string' ? args['threshold_pace'] : undefined,
          ftp_watts: typeof args['ftp_watts'] === 'number' ? args['ftp_watts'] : undefined,
          css_per_100m: typeof args['css_per_100m'] === 'string' ? args['css_per_100m'] : undefined,
          weight_kg: typeof args['weight_kg'] === 'number' ? args['weight_kg'] : undefined,
          vo2max_estimate: typeof args['vo2max_estimate'] === 'number' ? args['vo2max_estimate'] : undefined,
        }));
      }

      case 'recalibrate_plan': {
        requireAuth();
        return ok(await recalibratePlan());
      }

      case 'swap_sessions': {
        requireAuth();
        requireArgs(args, ['session_id_a', 'session_id_b']);
        return ok(await swapSessionsTool(args['session_id_a'] as string, args['session_id_b'] as string));
      }

      case 'move_session': {
        requireAuth();
        requireArgs(args, ['session_id', 'new_date']);
        return ok(await moveSessionTool(args['session_id'] as string, args['new_date'] as string));
      }

      case 'skip_session': {
        requireAuth();
        requireArgs(args, ['session_id']);
        return ok(await skipSessionTool(
          args['session_id'] as string,
          typeof args['reason'] === 'string' ? args['reason'] : undefined
        ));
      }

      case 'compress_week': {
        requireAuth();
        requireArgs(args, ['week_number', 'max_sessions']);
        return ok(await compressWeekTool(args['week_number'] as number, args['max_sessions'] as number));
      }

      case 'rescale_week': {
        requireAuth();
        requireArgs(args, ['week_number', 'load_factor']);
        return ok(await rescaleWeekTool(args['week_number'] as number, args['load_factor'] as number));
      }

      case 'add_note': {
        requireAuth();
        requireArgs(args, ['note']);
        return ok(await addNoteTool(
          args['note'] as string,
          typeof args['date'] === 'string' ? args['date'] : undefined
        ));
      }

      case 'analyse_workout': {
        requireAuth();
        requireArgs(args, ['strava_activity_id']);
        return ok(await analyseWorkout(args['strava_activity_id'] as string));
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof UserError) {
      return err(e.message);
    }
    logError(`Tool ${name} failed`, e);
    const message =
      e instanceof Error ? e.message :
      (typeof e === 'object' && e !== null && 'message' in e) ? String((e as Record<string, unknown>)['message']) :
      String(e);
    return err(`Unexpected error in ${name}: ${message}`);
  }
});

export { StdioServerTransport };
