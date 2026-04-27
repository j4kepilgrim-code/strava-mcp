import { loadTokens } from '../strava/auth';
import {
  getAthleteByStravaId,
  getLatestSnapshot,
  getSnapshots,
  upsertAthlete,
  getActivePlan,
  getSessionsByPlanId,
  updateSession,
} from '../db/queries';
import { buildPaceTargets, formatSec } from '../engine/operations';
import type { Athlete } from '../db/schema';

export async function getAthleteProfile(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found in database — run sync_recent_activities first');

  const snapshot = await getLatestSnapshot(athlete.id);

  const lines: string[] = [
    `## Athlete Profile — ${athlete.name ?? 'Unknown'}`,
    '',
    '### Training Thresholds',
    `- FTP: ${athlete.ftp_watts ? `${athlete.ftp_watts}w` : 'Not set'}`,
    `- Run threshold pace: ${athlete.threshold_pace ?? 'Not set'}`,
    `- Critical swim speed: ${athlete.css_per_100m ?? 'Not set'}`,
    `- Weight: ${athlete.weight_kg ? `${athlete.weight_kg}kg` : 'Not set'}`,
    `- VO2max estimate: ${athlete.vo2max_estimate ?? 'Not set'}`,
  ];

  if (snapshot) {
    const split = snapshot.sport_split;
    lines.push(
      '',
      '### Current Fitness (CTL/ATL/TSB)',
      `- CTL (fitness / chronic load): ${snapshot.ctl?.toFixed(1) ?? 'N/A'}`,
      `- ATL (fatigue / acute load): ${snapshot.atl?.toFixed(1) ?? 'N/A'}`,
      `- TSB (form = CTL − ATL): ${snapshot.tsb?.toFixed(1) ?? 'N/A'}${formLabel(snapshot.tsb)}`,
      '',
      '### Last 7 Days',
      `- Distance: ${formatKm(snapshot.weekly_distance_m)}`,
      `- Duration: ${formatDuration(snapshot.weekly_duration_s)}`,
      `- Elevation: ${snapshot.weekly_elevation_m ? `${Math.round(snapshot.weekly_elevation_m)}m` : '0m'}`,
    );

    if (split) {
      lines.push(
        '',
        '### Sport Split (last 28 days by moving time)',
        `- Run: ${split.run_pct}%`,
        `- Bike: ${split.bike_pct}%`,
        `- Swim: ${split.swim_pct}%`,
      );
    }

    lines.push('', `_Snapshot date: ${snapshot.snapshot_date}_`);
  } else {
    lines.push('', '_No fitness snapshot yet — run sync_recent_activities to generate one._');
  }

  return lines.join('\n');
}

export async function getFitnessTrend(weeks = 12): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const snapshots = await getSnapshots(athlete.id, Math.min(weeks, 52));

  if (snapshots.length === 0) {
    return 'No fitness data yet — run sync_recent_activities first.';
  }

  const lines = [
    `## Fitness Trend — last ${weeks} weeks`,
    '',
    '| Week | CTL (fitness) | ATL (fatigue) | TSB (form) |',
    '|------|--------------|--------------|-----------|',
  ];

  for (const s of snapshots) {
    lines.push(
      `| ${s.snapshot_date} | ${s.ctl?.toFixed(1) ?? '-'} | ${s.atl?.toFixed(1) ?? '-'} | ${s.tsb?.toFixed(1) ?? '-'}${formLabel(s.tsb)} |`
    );
  }

  lines.push('', '_CTL: higher = more fit. ATL: higher = more fatigued. TSB: positive = fresh, negative = tired._');
  return lines.join('\n');
}

function formLabel(tsb: number | null | undefined): string {
  if (tsb === null || tsb === undefined) return '';
  if (tsb > 10) return ' 🟢 fresh';
  if (tsb > 0) return ' 🟡 neutral';
  if (tsb > -10) return ' 🟠 tired';
  return ' 🔴 fatigued';
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

export async function updateAthleteProfile(updates: {
  threshold_pace?: string;
  ftp_watts?: number;
  css_per_100m?: string;
  weight_kg?: number;
  vo2max_estimate?: number;
}): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const updated = await upsertAthlete({
    ...athlete,
    ...updates,
  });

  const changes = Object.entries(updates)
    .map(([k, v]) => `- **${k.replace(/_/g, ' ')}:** ${v}`)
    .join('\n');

  return `## Athlete Profile Updated\n\n${changes}\n\nCall \`recalibrate_plan\` to apply new targets to your remaining planned sessions.`;
}

export async function recalibratePlan(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const plan = await getActivePlan(athlete.id);
  if (!plan) return 'No active training plan to recalibrate.';

  const sessions = await getSessionsByPlanId(plan.id);
  const plannedSessions = sessions.filter((s) => s.status === 'planned');

  if (plannedSessions.length === 0) return 'No remaining planned sessions to recalibrate.';

  if (!athlete.threshold_pace) {
    return 'Athlete has no threshold pace set — call update_athlete_profile first to set threshold_pace.';
  }

  const [min, sec] = athlete.threshold_pace.split(':').map(Number);
  const thresholdSec = (min ?? 0) * 60 + (sec ?? 0);

  let updatedCount = 0;
  const changes: string[] = [];

  for (const session of plannedSessions) {
    if (session.session_type === 'race' || session.session_type === 'recovery') continue;

    const newTargets = buildPaceTargets(session.session_type as Parameters<typeof buildPaceTargets>[0], thresholdSec);
    if (!newTargets.pace_zone) continue;

    const oldPace = session.targets?.pace_zone;
    if (oldPace === newTargets.pace_zone) continue;

    await updateSession(session.id, {
      targets: { ...session.targets, ...newTargets },
    });
    updatedCount++;

    if (changes.length < 3) {
      changes.push(`${session.session_type.replace('_', ' ')}: ${oldPace ?? 'none'} → ${newTargets.pace_zone}`);
    }
  }

  const sample = changes.length > 0 ? `\n\nSample changes:\n${changes.map((c) => `- ${c}`).join('\n')}` : '';
  return `Recalibrated ${updatedCount} of ${plannedSessions.length} remaining sessions with updated pace zones based on ${athlete.threshold_pace}/km threshold pace.${sample}`;
}
