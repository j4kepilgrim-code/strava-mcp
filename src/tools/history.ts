import { loadTokens } from '../strava/auth';
import { getAthleteByStravaId, getActivities, getActivityById, updateActivitySportData } from '../db/queries';
import { getActivityDetail as fetchStravaDetail } from '../strava/client';
import type { Activity, RunData, RideData, LapData } from '../db/schema';
import type { StravaLap } from '../strava/types';

export async function getActivityHistory(weeks = 8, sport?: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - weeks * 7);
  const afterStr = afterDate.toISOString().split('T')[0];

  const activities = await getActivities(athlete.id, afterStr, sport);

  if (activities.length === 0) {
    return `No ${sport ? sport + ' ' : ''}activities found in the last ${weeks} weeks.`;
  }

  // Group by ISO week (Monday as week start)
  const byWeek = new Map<string, Activity[]>();
  for (const a of activities) {
    const weekStart = getWeekStart(a.activity_date);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart)!.push(a);
  }

  const sortedWeeks = [...byWeek.keys()].sort().reverse();

  const lines = [
    `## Activity History — last ${weeks} weeks${sport ? ` (${sport})` : ''}`,
    '',
    '| Week of | Sessions | Distance | Duration | Elevation |',
    '|---------|----------|----------|----------|-----------|',
  ];

  for (const weekStart of sortedWeeks) {
    const week = byWeek.get(weekStart)!;
    const totalDist = week.reduce((s, a) => s + (a.distance_m ?? 0), 0);
    const totalDur = week.reduce((s, a) => s + (a.moving_time_s ?? 0), 0);
    const totalElev = week.reduce((s, a) => s + (a.elevation_gain_m ?? 0), 0);
    const sportBreakdown = getSportBreakdown(week);

    lines.push(
      '',
      `### Week of ${weekStart} — ${week.length} sessions (${sportBreakdown}) | ${formatKm(totalDist)} | ${formatDuration(totalDur)} | ${Math.round(totalElev)}m elev`,
      ''
    );

    for (const a of [...week].sort((x, y) => x.activity_date.localeCompare(y.activity_date))) {
      const dayName = new Date(a.activity_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      const pace = getPaceString(a);
      const hr = a.avg_hr ? ` | ${a.avg_hr}bpm` : '';
      lines.push(
        `- **${dayName}** — ${a.sport_type} ${formatKm(a.distance_m)} ${formatDuration(a.moving_time_s)}${pace}${hr}`,
        `  - DB ID: \`${a.id}\` | Strava ID: \`${a.strava_id}\``
      );
    }
  }

  lines.push('', `_${activities.length} total sessions shown. Use DB ID with \`get_activity_detail\` or Strava ID with \`analyse_workout\`._`);
  return lines.join('\n');
}

export async function getActivityDetail(activityId: string): Promise<string> {
  const activity = await getActivityById(activityId);
  if (!activity) return `No activity found with ID: ${activityId}`;

  // Fetch laps from Strava if not yet cached
  const sportData = activity.sport_data as unknown as (RunData | RideData) & { laps?: LapData[] } | null;
  if (activity.strava_id && (!sportData?.laps || sportData.laps.length === 0)) {
    try {
      const detail = await fetchStravaDetail(activity.strava_id);
      if (detail.laps && detail.laps.length > 0) {
        const laps = mapLaps(detail.laps, activity.sport_type);
        const updated = { ...(sportData ?? {}), laps };
        await updateActivitySportData(activity.id, updated);
        (activity as unknown as { sport_data: unknown }).sport_data = updated;
      }
    } catch {
      // Non-fatal — show activity without laps if Strava fetch fails
    }
  }

  const lines = [
    `## Activity — ${activity.sport_type} on ${activity.activity_date}`,
    '',
    `- **Distance:** ${formatKm(activity.distance_m)}`,
    `- **Moving time:** ${formatDuration(activity.moving_time_s)}`,
    `- **Elevation gain:** ${activity.elevation_gain_m ? `${Math.round(activity.elevation_gain_m)}m` : 'N/A'}`,
    `- **Avg HR:** ${activity.avg_hr ? `${activity.avg_hr} bpm` : 'N/A'}`,
    `- **Max HR:** ${activity.max_hr ? `${activity.max_hr} bpm` : 'N/A'}`,
    `- **Suffer score:** ${activity.suffer_score ?? 'N/A'}`,
    `- **Perceived effort:** ${activity.perceived_effort ?? 'N/A'}`,
  ];

  const d = activity.sport_data as unknown as Record<string, unknown> | null;
  if (d) {
    lines.push('', '### Sport Metrics');
    for (const [key, value] of Object.entries(d)) {
      if (key === 'laps' || value === null || value === undefined) continue;
      lines.push(`- **${formatKey(key)}:** ${value}`);
    }
  }

  // Lap breakdown
  const laps = (d?.['laps'] as LapData[] | undefined);
  if (laps && laps.length > 0) {
    lines.push('', '### Lap Breakdown');
    lines.push('| Lap | Distance | Time | Pace / Speed | HR | Cadence |');
    lines.push('|-----|----------|------|--------------|----|---------|');
    for (const lap of laps) {
      const pace = lap.avg_pace_per_km ? `${lap.avg_pace_per_km}/km` : lap.avg_speed_kph ? `${lap.avg_speed_kph}km/h` : '—';
      lines.push(
        `| ${lap.lap_index} | ${formatKm(lap.distance_m)} | ${formatDuration(lap.moving_time_s)} | ${pace} | ${lap.avg_hr ?? '—'} | ${lap.avg_cadence ?? '—'} |`
      );
    }
  }

  lines.push('', `_Strava ID: ${activity.strava_id}_`);
  return lines.join('\n');
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

function getSportBreakdown(activities: Activity[]): string {
  const counts: Record<string, number> = {};
  for (const a of activities) {
    counts[a.sport_type] = (counts[a.sport_type] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([s, n]) => `${n} ${s.toLowerCase()}`)
    .join(', ');
}

function formatKm(metres: number | null | undefined): string {
  if (!metres) return '0km';
  return `${(metres / 1000).toFixed(1)}km`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapLaps(stravaLaps: StravaLap[], sportType: string): LapData[] {
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

function getPaceString(a: Activity): string {
  if (!a.sport_data) return '';
  const d = a.sport_data as unknown as Record<string, unknown>;
  if (a.sport_type === 'Run' && d['avg_pace_per_km']) return ` @ ${d['avg_pace_per_km']}/km`;
  if (a.sport_type === 'Ride' && d['avg_speed_kph']) return ` @ ${d['avg_speed_kph']}km/h`;
  if (a.sport_type === 'Swim' && d['avg_pace_per_100m']) return ` @ ${d['avg_pace_per_100m']}/100m`;
  return '';
}
