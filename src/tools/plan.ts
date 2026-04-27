import crypto from 'crypto';
import { loadTokens } from '../strava/auth';
import {
  getAthleteByStravaId,
  getActivePlan,
  getSessionsByPlanId,
  getSessionsByWeek,
  insertPlan,
  insertPlanSessions,
  updatePlanStatus,
  getLatestSnapshot,
  getActivities,
} from '../db/queries';
import {
  generatePlan,
  getPlanRecommendation,
  MIN_WEEKS,
  type GoalType,
} from '../engine/plan';
import type { Plan, PlanConstraints } from '../db/schema';

export async function getCurrentPlan(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const plan = await getActivePlan(athlete.id);
  if (!plan) return 'No active training plan. Call create_plan to generate one.';

  const sessions = await getSessionsByPlanId(plan.id);
  const today = new Date().toISOString().split('T')[0]!;

  // Find this week's sessions
  const thisWeekSessions = sessions.filter((s) => {
    const d = new Date(s.scheduled_date);
    const weekStart = new Date(d);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    weekStart.setUTCDate(d.getUTCDate() + diff);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

    const todayDate = new Date(today);
    const thisWeekStart = new Date(todayDate);
    const todayDay = todayDate.getUTCDay();
    const todayDiff = todayDay === 0 ? -6 : 1 - todayDay;
    thisWeekStart.setUTCDate(todayDate.getUTCDate() + todayDiff);
    const thisWeekEnd = new Date(thisWeekStart);
    thisWeekEnd.setUTCDate(thisWeekStart.getUTCDate() + 6);

    return d >= thisWeekStart && d <= thisWeekEnd;
  });

  const weeksToGoal = Math.ceil(
    (new Date(plan.goal_date).getTime() - new Date(today).getTime()) / (7 * 86400000)
  );

  const lines = [
    `## Active Plan — ${plan.goal_type.replace('_', ' ')} by ${plan.goal_date}`,
    plan.goal_description ? `_Goal: ${plan.goal_description}_` : '',
    '',
    `${weeksToGoal} weeks to goal date.`,
    '',
    "### This Week's Sessions",
    '',
  ].filter((l) => l !== null);

  if (thisWeekSessions.length === 0) {
    lines.push('No sessions scheduled this week.');
  } else {
    for (const s of thisWeekSessions.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))) {
      const dayName = new Date(s.scheduled_date).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const status = s.status !== 'planned' ? ` _(${s.status})_` : '';
      lines.push(`**${dayName} ${s.scheduled_date}** — ${formatSessionType(s.session_type)} [${s.priority}]${status}`);
      if (s.targets?.pace_zone) lines.push(`  - Pace: ${s.targets.pace_zone}`);
      if (s.targets?.duration_s) lines.push(`  - Duration: ${formatDuration(s.targets.duration_s)}`);
      if (s.targets?.distance_m) lines.push(`  - Distance: ${(s.targets.distance_m / 1000).toFixed(1)}km`);
      lines.push(`  - _${s.rationale}_`);
      lines.push(`  - Session ID: \`${s.id}\``);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export async function getWeekSessions(weekNumber: number): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const plan = await getActivePlan(athlete.id);
  if (!plan) return 'No active training plan.';

  const sessions = await getSessionsByWeek(plan.id, weekNumber);
  if (sessions.length === 0) return `No sessions found for week ${weekNumber}.`;

  const lines = [
    `## Week ${weekNumber} — ${plan.goal_type.replace('_', ' ')} plan`,
    '',
  ];

  for (const s of sessions.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))) {
    const dayName = new Date(s.scheduled_date).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const status = s.status !== 'planned' ? ` _(${s.status})_` : '';
    lines.push(`**${dayName} ${s.scheduled_date}** — ${formatSessionType(s.session_type)} [${s.priority}]${status}`);
    if (s.targets?.pace_zone) lines.push(`  - Pace: ${s.targets.pace_zone}`);
    if (s.targets?.duration_s) lines.push(`  - Duration: ${formatDuration(s.targets.duration_s)}`);
    if (s.targets?.distance_m) lines.push(`  - Distance: ${(s.targets.distance_m / 1000).toFixed(1)}km`);
    lines.push(`  - _${s.rationale}_`);
    lines.push(`  - Session ID: \`${s.id}\``);
    lines.push('');
  }

  return lines.join('\n');
}

export async function createPlan(params: {
  goal_type: string;
  goal_date: string;
  goal_description?: string;
  available_days: number;
  max_hours_per_week: number;
  start_date?: string;
}): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const runningGoals: GoalType[] = ['5k', '10k', 'half_marathon', 'marathon'];
  const goalType = params.goal_type as GoalType;

  if (!runningGoals.includes(goalType)) {
    return `Goal type "${params.goal_type}" is not yet supported. Supported types: ${runningGoals.join(', ')}.`;
  }

  const today = new Date().toISOString().split('T')[0]!;
  const planStart = params.start_date ?? today;
  const weeksToGoal = Math.ceil(
    (new Date(params.goal_date).getTime() - new Date(planStart).getTime()) / (7 * 86400000)
  );

  const minWeeks = MIN_WEEKS[goalType];
  if (weeksToGoal < minWeeks) {
    const alternatives: Record<GoalType, GoalType | null> = {
      'marathon': 'half_marathon',
      'half_marathon': '10k',
      '10k': '5k',
      '5k': null,
    };
    const alt = alternatives[goalType];
    const altMsg = alt
      ? ` I could build you a ${alt.replace('_', ' ')} plan instead, or push the goal date to at least ${minWeeksDate(minWeeks)}.`
      : ' Consider choosing a later race date.';
    return `You have ${weeksToGoal} week${weeksToGoal === 1 ? '' : 's'} to ${params.goal_date} — not enough for a ${goalType.replace('_', ' ')} (needs ${minWeeks} weeks minimum).${altMsg}`;
  }

  // Archive any existing active plan
  const existingPlan = await getActivePlan(athlete.id);
  if (existingPlan) {
    await updatePlanStatus(existingPlan.id, 'archived');
  }

  const constraints: PlanConstraints = {
    available_days: params.available_days,
    max_hours_per_week: params.max_hours_per_week,
    preferred_session_types: [],
    excluded_days: [],
  };

  const newPlan: Plan = {
    id: crypto.randomUUID(),
    athlete_id: athlete.id,
    goal_type: goalType,
    goal_date: params.goal_date,
    goal_description: params.goal_description ?? null,
    status: 'active',
    constraints,
    created_at: new Date().toISOString(),
  };

  const snapshot = await getLatestSnapshot(athlete.id);
  const sessions = generatePlan(newPlan, athlete, snapshot, params.start_date);

  await insertPlan({
    id: newPlan.id,
    athlete_id: newPlan.athlete_id,
    goal_type: newPlan.goal_type,
    goal_date: newPlan.goal_date,
    goal_description: newPlan.goal_description,
    status: newPlan.status,
    constraints: newPlan.constraints,
  });

  await insertPlanSessions(sessions);

  return [
    `## Plan Created — ${goalType.replace('_', ' ')} by ${params.goal_date}`,
    '',
    `- **Starts:** ${planStart}`,
    `- **${weeksToGoal} weeks** to race day`,
    `- **${sessions.length} sessions** generated`,
    `- **${params.available_days} days/week**, max ${params.max_hours_per_week}h`,
    params.goal_description ? `- **Goal:** ${params.goal_description}` : '',
    snapshot ? `- **Starting CTL:** ${snapshot.ctl?.toFixed(1) ?? 'N/A'} — ${ctlLabel(snapshot.ctl)}` : '',
    '',
    `Call \`get_current_plan\` to see this week's sessions.`,
  ].filter(Boolean).join('\n');
}

export async function getPlanRecommendationTool(goal_type: string, goal_date: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const snapshot = await getLatestSnapshot(athlete.id);

  const today = new Date().toISOString().split('T')[0]!;
  const weeksToGoal = Math.ceil(
    (new Date(goal_date).getTime() - new Date(today).getTime()) / (7 * 86400000)
  );

  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - 56);
  const recentActivities = await getActivities(athlete.id, afterDate.toISOString().split('T')[0]!);

  const sessionsPerWeek = recentActivities.length / 8;
  const ctl = snapshot?.ctl ?? 20;
  const weeklyDistanceM = snapshot?.weekly_distance_m ?? 0;
  const weeklyDurationS = snapshot?.weekly_duration_s ?? 0;

  const rec = getPlanRecommendation(ctl, weeklyDistanceM, weeklyDurationS, sessionsPerWeek);

  const goalTypeName = goal_type.replace('_', ' ');
  const minWeeks = MIN_WEEKS[goal_type as GoalType];
  const feasible = weeksToGoal >= minWeeks;

  const lines = [
    `## Plan Recommendation — ${goalTypeName}`,
    '',
    `**${weeksToGoal} weeks** to ${goal_date}${feasible ? '' : ` ⚠️ (minimum ${minWeeks} weeks needed)`}`,
    '',
    '### Your Recent Training',
    `- Sessions per week: ${sessionsPerWeek.toFixed(1)}`,
    `- Weekly distance: ${weeklyDistanceM ? `${(weeklyDistanceM / 1000).toFixed(1)}km` : 'N/A'}`,
    `- Weekly duration: ${weeklyDurationS ? formatDuration(weeklyDurationS) : 'N/A'}`,
    `- Current CTL: ${ctl.toFixed(1)} — ${rec.readiness}`,
    '',
    '### Suggested Parameters',
    `- Training days per week: **${rec.suggested_days}**`,
    `- Max hours per week: **${rec.suggested_hours}h**`,
    '',
    feasible
      ? `Ready to create your plan? Call \`create_plan\` with these parameters, or adjust them to fit your schedule.`
      : `You need at least ${minWeeks} weeks for a ${goalTypeName}. Consider a later race date or a shorter goal (e.g. ${shorterGoal(goal_type as GoalType)}).`,
  ];

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSessionType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function ctlLabel(ctl: number | null | undefined): string {
  if (!ctl) return 'no base data';
  if (ctl < 30) return 'low base';
  if (ctl < 50) return 'moderate base';
  if (ctl < 70) return 'solid base';
  return 'strong base';
}

function minWeeksDate(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().split('T')[0]!;
}

function shorterGoal(goalType: GoalType): string {
  const shorter: Record<GoalType, string> = {
    'marathon': 'half marathon',
    'half_marathon': '10k',
    '10k': '5k',
    '5k': 'a longer goal window',
  };
  return shorter[goalType];
}
