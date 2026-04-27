import { loadTokens } from '../strava/auth';
import { getAthleteByStravaId, getActivities, getActivityById } from '../db/queries';
import type { Activity } from '../db/schema';

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
      `| ${weekStart} | ${week.length} (${sportBreakdown}) | ${formatKm(totalDist)} | ${formatDuration(totalDur)} | ${Math.round(totalElev)}m |`
    );
  }

  lines.push('', `_${activities.length} total sessions shown_`);
  return lines.join('\n');
}

export async function getActivityDetail(activityId: string): Promise<string> {
  const activity = await getActivityById(activityId);
  if (!activity) return `No activity found with ID: ${activityId}`;

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

  if (activity.sport_data) {
    lines.push('', '### Sport Metrics');
    const d = activity.sport_data as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(d)) {
      if (value !== null && value !== undefined) {
        lines.push(`- **${formatKey(key)}:** ${value}`);
      }
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
