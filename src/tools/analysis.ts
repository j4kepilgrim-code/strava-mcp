import { loadTokens } from '../strava/auth';
import {
  getAthleteByStravaId,
  getActivityByStravaId,
  getActivePlan,
  getSessionsByPlanId,
  getLatestSnapshot,
  getActivities,
  updateActivitySportData,
} from '../db/queries';
import { getActivityDetail as fetchStravaDetail } from '../strava/client';
import type { Activity, AthleteSnapshot, Athlete, PlanSession, RunData, RideData, SwimData, LapData } from '../db/schema';

export async function analyseWorkout(stravaActivityId: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const activity = await getActivityByStravaId(stravaActivityId);
  if (!activity) {
    return `Activity ${stravaActivityId} not found in the database. Run sync_recent_activities first to pull in recent activities, then try again.`;
  }

  // Fetch laps from Strava if not cached (do this early so they're available in the report)
  const sportData = activity.sport_data as unknown as (RunData | RideData) & { laps?: LapData[] } | null;
  if (activity.strava_id && (!sportData?.laps || sportData.laps.length === 0)) {
    try {
      const detail = await fetchStravaDetail(activity.strava_id);
      if (detail.laps && detail.laps.length > 0) {
        const laps = mapLapsFromStrava(detail.laps, activity.sport_type);
        const updated = { ...(sportData ?? {}), laps };
        await updateActivitySportData(activity.id, updated);
        (activity as unknown as { sport_data: unknown }).sport_data = updated;
      }
    } catch {
      // Non-fatal
    }
  }

  // Find matching plan session and week context
  const plan = await getActivePlan(athlete.id);
  let matchedSession: PlanSession | null = null;
  let weekSessions: PlanSession[] = [];

  if (plan) {
    const allSessions = await getSessionsByPlanId(plan.id);
    matchedSession = findMatchingSession(activity, allSessions);

    const weekStart = getWeekStart(activity.activity_date);
    const weekEnd = addDays(weekStart, 6);
    weekSessions = allSessions.filter(
      (s) => s.scheduled_date >= weekStart && s.scheduled_date <= weekEnd
    );
  }

  // Previous activity of same sport type for trend comparison
  const ninetyDaysAgo = addDays(activity.activity_date, -90);
  const recentSameType = await getActivities(athlete.id, ninetyDaysAgo, activity.sport_type);
  const previousActivity = recentSameType.find(
    (a) => a.id !== activity.id && a.activity_date < activity.activity_date
  ) ?? null;

  const snapshot = await getLatestSnapshot(athlete.id);

  return formatReport(activity, matchedSession, weekSessions, previousActivity, snapshot, athlete);
}

// ─── Lap mapping ─────────────────────────────────────────────────────────────

function mapLapsFromStrava(stravaLaps: { lap_index: number; distance: number; moving_time: number; average_speed: number; average_heartrate?: number; max_heartrate?: number; average_cadence?: number; average_watts?: number }[], sportType: string): LapData[] {
  return stravaLaps.map((lap) => {
    const base: LapData = {
      lap_index: lap.lap_index,
      distance_m: Math.round(lap.distance),
      moving_time_s: lap.moving_time,
      avg_hr: lap.average_heartrate ? Math.round(lap.average_heartrate) : undefined,
      max_hr: lap.max_heartrate ? Math.round(lap.max_heartrate) : undefined,
      avg_cadence: lap.average_cadence ? Math.round(lap.average_cadence) : undefined,
      avg_watts: lap.average_watts ? Math.round(lap.average_watts) : undefined,
    };
    if (sportType === 'Run' && lap.average_speed) {
      const secPerKm = Math.round(1000 / lap.average_speed);
      const m = Math.floor(secPerKm / 60);
      const s = secPerKm % 60;
      base.avg_pace_per_km = `${m}:${s.toString().padStart(2, '0')}`;
    } else if (sportType === 'Ride' && lap.average_speed) {
      base.avg_speed_kph = Math.round(lap.average_speed * 3.6 * 10) / 10;
    }
    return base;
  });
}

// ─── Session matching ─────────────────────────────────────────────────────────

function findMatchingSession(activity: Activity, sessions: PlanSession[]): PlanSession | null {
  const sportMap: Record<string, string> = {
    Run: 'run',
    Ride: 'bike',
    Swim: 'swim',
    WeightTraining: 'strength',
  };
  const targetSport = sportMap[activity.sport_type];

  const candidates = sessions.filter(
    (s) =>
      s.sport === targetSport &&
      s.status !== 'skipped' &&
      daysDiff(s.scheduled_date, activity.activity_date) <= 3
  );

  if (candidates.length === 0) return null;

  // Prefer already-linked, then closest by date, then planned over completed
  return candidates.sort((a, b) => {
    if (a.strava_activity_id === activity.strava_id) return -1;
    if (b.strava_activity_id === activity.strava_id) return 1;
    return daysDiff(a.scheduled_date, activity.activity_date) - daysDiff(b.scheduled_date, activity.activity_date);
  })[0] ?? null;
}

// ─── Report formatting ────────────────────────────────────────────────────────

function formatReport(
  activity: Activity,
  session: PlanSession | null,
  weekSessions: PlanSession[],
  previous: Activity | null,
  snapshot: AthleteSnapshot | null,
  athlete: Athlete
): string {
  const dayName = new Date(activity.activity_date).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC',
  });

  const lines: string[] = [
    `## Workout Analysis — ${activity.sport_type} on ${dayName}`,
    '',
  ];

  // ── Planned session ──────────────────────────────────────────────────────
  if (session) {
    lines.push('### Planned Session');
    lines.push(`- **Type:** ${formatType(session.session_type)} [${session.priority}]`);
    if (session.targets?.duration_s) lines.push(`- **Target duration:** ${formatDuration(session.targets.duration_s)}`);
    if (session.targets?.distance_m) lines.push(`- **Target distance:** ${(session.targets.distance_m / 1000).toFixed(1)}km`);
    if (session.targets?.pace_zone) lines.push(`- **Target pace:** ${session.targets.pace_zone}`);
    lines.push(`- **Rationale:** _${session.rationale}_`);
    lines.push('');
  } else {
    lines.push('_No matching planned session found — this may be an unplanned workout._');
    lines.push('');
  }

  // ── Actual performance ───────────────────────────────────────────────────
  lines.push('### Actual Performance');
  if (activity.distance_m) lines.push(`- **Distance:** ${(activity.distance_m / 1000).toFixed(2)}km`);
  if (activity.moving_time_s) lines.push(`- **Duration:** ${formatDuration(activity.moving_time_s)}`);

  const sportLines = formatSportData(activity);
  lines.push(...sportLines);

  if (activity.avg_hr) lines.push(`- **Avg HR:** ${activity.avg_hr}bpm${activity.max_hr ? ` | Max: ${activity.max_hr}bpm` : ''}`);
  if (activity.suffer_score) lines.push(`- **Suffer score:** ${activity.suffer_score}`);
  if (activity.perceived_effort) lines.push(`- **Perceived effort:** ${activity.perceived_effort}/10`);
  lines.push('');

  // ── Lap breakdown (intervals/threshold) ─────────────────────────────────
  const laps = ((activity.sport_data as unknown as Record<string, unknown> | null)?.['laps'] as LapData[] | undefined);
  if (laps && laps.length > 1) {
    lines.push('### Lap Breakdown');
    lines.push('| Lap | Distance | Time | Pace / Speed | HR | Cadence |');
    lines.push('|-----|----------|------|--------------|----|---------|');
    for (const lap of laps) {
      const pace = lap.avg_pace_per_km ? `${lap.avg_pace_per_km}/km` : lap.avg_speed_kph ? `${lap.avg_speed_kph}km/h` : '—';
      lines.push(
        `| ${lap.lap_index} | ${(lap.distance_m / 1000).toFixed(2)}km | ${formatDuration(lap.moving_time_s)} | ${pace} | ${lap.avg_hr ?? '—'} | ${lap.avg_cadence ?? '—'} |`
      );
    }
    lines.push('');
  }

  // ── Fitness context ──────────────────────────────────────────────────────
  if (snapshot) {
    lines.push('### Fitness Context');
    lines.push(
      `- **CTL:** ${snapshot.ctl?.toFixed(1) ?? 'N/A'} (fitness) | **ATL:** ${snapshot.atl?.toFixed(1) ?? 'N/A'} (fatigue) | **TSB:** ${snapshot.tsb?.toFixed(1) ?? 'N/A'}${tsbLabel(snapshot.tsb)}`
    );
    lines.push('');
  }

  // ── Week in context ──────────────────────────────────────────────────────
  if (weekSessions.length > 0) {
    const weekStart = getWeekStart(activity.activity_date);
    const weekEnd = addDays(weekStart, 6);
    lines.push(`### This Week (${formatDateRange(weekStart, weekEnd)})`);
    for (const s of weekSessions.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))) {
      const isThis = s.id === session?.id;
      const statusIcon = s.status === 'completed' ? '✅' : s.status === 'skipped' ? '⏭️' : s.id === session?.id ? '📍' : '📅';
      const label = isThis ? ' _(this session)_' : '';
      lines.push(`- ${statusIcon} ${formatDateShort(s.scheduled_date)}: ${formatType(s.session_type)} [${s.priority}]${label}`);
    }
    lines.push('');
  }

  // ── Previous similar activity comparison ─────────────────────────────────
  if (previous) {
    lines.push(`### Previous ${activity.sport_type} Session (${previous.activity_date})`);
    if (previous.distance_m) lines.push(`- **Distance:** ${(previous.distance_m / 1000).toFixed(2)}km`);
    if (previous.moving_time_s) lines.push(`- **Duration:** ${formatDuration(previous.moving_time_s)}`);

    const prevSportLines = formatSportData(previous);
    lines.push(...prevSportLines);

    if (previous.avg_hr) lines.push(`- **Avg HR:** ${previous.avg_hr}bpm`);

    // Pace trend
    const paceTrend = getPaceTrend(activity, previous);
    if (paceTrend) lines.push(``, `**Trend:** ${paceTrend}`);

    lines.push('');
  }

  lines.push(`_Strava activity ID: ${activity.strava_id}_`);
  return lines.join('\n');
}

// ─── Sport-specific metrics ───────────────────────────────────────────────────

function formatSportData(activity: Activity): string[] {
  const lines: string[] = [];
  const d = activity.sport_data as Record<string, unknown> | null;
  if (!d) return lines;

  if (activity.sport_type === 'Run') {
    const run = d as unknown as RunData;
    if (run.avg_pace_per_km) lines.push(`- **Avg pace:** ${run.avg_pace_per_km}/km`);
    if (run.avg_cadence) lines.push(`- **Cadence:** ${run.avg_cadence}spm`);
    if (run.avg_power) lines.push(`- **Avg power:** ${run.avg_power}w`);
  } else if (activity.sport_type === 'Ride') {
    const ride = d as unknown as RideData;
    if (ride.avg_speed_kph) lines.push(`- **Avg speed:** ${ride.avg_speed_kph}km/h`);
    if (ride.avg_power_w) lines.push(`- **Avg power:** ${ride.avg_power_w}w${ride.np_w ? ` | NP: ${ride.np_w}w` : ''}`);
    if (ride.avg_cadence) lines.push(`- **Cadence:** ${ride.avg_cadence}rpm`);
  } else if (activity.sport_type === 'Swim') {
    const swim = d as unknown as SwimData;
    if (swim.avg_pace_per_100m) lines.push(`- **Avg pace:** ${swim.avg_pace_per_100m}/100m`);
    if (swim.pool_length_m) lines.push(`- **Pool length:** ${swim.pool_length_m}m`);
    if (swim.avg_stroke_rate) lines.push(`- **Stroke rate:** ${swim.avg_stroke_rate}spm`);
  }

  return lines;
}

// ─── Trend analysis ───────────────────────────────────────────────────────────

function getPaceTrend(current: Activity, previous: Activity): string | null {
  if (current.sport_type === 'Run') {
    const curr = current.sport_data as unknown as RunData | null;
    const prev = previous.sport_data as unknown as RunData | null;
    if (!curr?.avg_pace_per_km || !prev?.avg_pace_per_km) return null;

    const currSec = paceToSec(curr.avg_pace_per_km);
    const prevSec = paceToSec(prev.avg_pace_per_km);
    if (currSec === null || prevSec === null) return null;

    const diff = prevSec - currSec; // positive = faster
    if (Math.abs(diff) < 3) return `Pace consistent with previous session (${curr.avg_pace_per_km}/km vs ${prev.avg_pace_per_km}/km)`;
    const direction = diff > 0 ? 'faster' : 'slower';
    return `${Math.abs(diff)}s/km ${direction} than previous session (${curr.avg_pace_per_km}/km vs ${prev.avg_pace_per_km}/km)`;
  }

  if (current.sport_type === 'Ride') {
    const curr = current.sport_data as unknown as RideData | null;
    const prev = previous.sport_data as unknown as RideData | null;
    if (!curr?.avg_power_w || !prev?.avg_power_w) return null;

    const diff = curr.avg_power_w - prev.avg_power_w;
    if (Math.abs(diff) < 5) return `Power consistent with previous session (${curr.avg_power_w}w vs ${prev.avg_power_w}w)`;
    const direction = diff > 0 ? 'higher' : 'lower';
    return `${Math.abs(diff)}w ${direction} than previous session (${curr.avg_power_w}w vs ${prev.avg_power_w}w)`;
  }

  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0]!;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0]!;
}

function daysDiff(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
}

function paceToSec(pace: string): number | null {
  const parts = pace.split(':').map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  return parts[0]! * 60 + parts[1]!;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatDateRange(start: string, end: string): string {
  return `${formatDateShort(start)} – ${formatDateShort(end)}`;
}

function tsbLabel(tsb: number | null | undefined): string {
  if (tsb === null || tsb === undefined) return '';
  if (tsb > 10) return ' 🟢 fresh';
  if (tsb > 0) return ' 🟡 neutral';
  if (tsb > -10) return ' 🟠 tired';
  return ' 🔴 fatigued';
}
