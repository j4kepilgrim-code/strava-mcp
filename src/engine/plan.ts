import crypto from 'crypto';
import type { Plan, Athlete, AthleteSnapshot, NewPlanSession, PlanSession, SessionTargets } from '../db/schema';
import { buildPaceTargets, formatSec, describeSession } from './operations';

export type GoalType = '5k' | '10k' | 'half_marathon' | 'marathon';
export type Phase = 'base' | 'build' | 'peak' | 'taper';
export type SessionType = PlanSession['session_type'];

// ─── Phase lengths (in weeks) ──────────────────────────────────────────────────

const PHASE_WEEKS: Record<GoalType, { base: number; build: number; peak: number; taper: number }> = {
  '5k':            { base: 2, build: 3, peak: 2, taper: 1 },
  '10k':           { base: 3, build: 5, peak: 3, taper: 2 },
  'half_marathon': { base: 5, build: 7, peak: 3, taper: 2 },
  'marathon':      { base: 7, build: 9, peak: 4, taper: 4 },
};

export const MIN_WEEKS: Record<GoalType, number> = {
  '5k': 6,
  '10k': 8,
  'half_marathon': 10,
  'marathon': 16,
};

const RACE_DISTANCE_M: Record<GoalType, number> = {
  '5k': 5000,
  '10k': 10000,
  'half_marathon': 21097,
  'marathon': 42195,
};

// ─── Volume calibration ────────────────────────────────────────────────────────

function startingHoursFraction(ctl: number): number {
  if (ctl < 30) return 0.50;
  if (ctl < 50) return 0.60;
  if (ctl < 70) return 0.70;
  return 0.80;
}

export function getPhase(weekNumber: number, totalWeeks: number, goalType: GoalType): Phase {
  const phases = PHASE_WEEKS[goalType];
  if (!phases) return 'build';

  if (weekNumber <= phases.base) return 'base';
  if (weekNumber <= phases.base + phases.build) return 'build';
  if (weekNumber <= phases.base + phases.build + phases.peak) return 'peak';
  return 'taper';
}

export function isRecoveryWeek(weekNumber: number, ctl: number): boolean {
  const cycle = ctl >= 50 ? 4 : 3; // 3:1 or 2:1 (every 3rd or every 2nd week is recovery)
  return weekNumber % cycle === 0;
}

export function calculateWeeklyHours(
  weekNumber: number,
  baseHours: number,
  phase: Phase,
  isRecovery: boolean
): number {
  if (isRecovery) return baseHours * 0.65;

  const progressRate = 0.06; // 6% per build week
  let hours = baseHours * Math.pow(1 + progressRate, weekNumber - 1);

  // Cap at sensible limits per phase
  if (phase === 'taper') hours = baseHours * 0.75 * Math.pow(0.85, weekNumber);
  if (phase === 'peak') hours = Math.min(hours, baseHours * 1.3);

  return Math.min(hours, baseHours * 1.5);
}

// ─── Session templates by available_days ──────────────────────────────────────

interface SessionTemplate {
  type: SessionType;
  priority: PlanSession['priority'];
}

function getWeekTemplate(availableDays: number, phase: Phase): SessionTemplate[] {
  const base: SessionTemplate[] = [
    { type: 'long_run', priority: 'key' },
    { type: 'easy_run', priority: 'standard' },
  ];

  const hardSession = (phase === 'base' ? 'tempo' : phase === 'build' ? 'threshold' : 'intervals');

  if (availableDays === 3) {
    return [
      { type: 'long_run', priority: 'key' },
      { type: hardSession, priority: 'key' },
      { type: 'easy_run', priority: 'standard' },
    ];
  }
  if (availableDays === 4) {
    return [
      { type: 'long_run', priority: 'key' },
      { type: hardSession, priority: 'key' },
      { type: 'easy_run', priority: 'standard' },
      { type: 'recovery', priority: 'optional' },
    ];
  }
  if (availableDays === 5) {
    return [
      { type: 'long_run', priority: 'key' },
      { type: hardSession, priority: 'key' },
      { type: 'tempo', priority: 'standard' },
      { type: 'easy_run', priority: 'standard' },
      { type: 'easy_run', priority: 'standard' },
    ];
  }
  // 6+ days
  return [
    { type: 'long_run', priority: 'key' },
    { type: hardSession, priority: 'key' },
    { type: 'tempo', priority: 'standard' },
    { type: 'easy_run', priority: 'standard' },
    { type: 'easy_run', priority: 'standard' },
    { type: 'recovery', priority: 'optional' },
  ];
}

function getTaperTemplate(availableDays: number): SessionTemplate[] {
  if (availableDays <= 3) {
    return [
      { type: 'long_run', priority: 'key' },
      { type: 'threshold', priority: 'key' },
      { type: 'easy_run', priority: 'standard' },
    ];
  }
  return [
    { type: 'long_run', priority: 'key' },
    { type: 'threshold', priority: 'key' },
    { type: 'easy_run', priority: 'standard' },
    { type: 'recovery', priority: 'optional' },
  ];
}

// ─── Target calculation ────────────────────────────────────────────────────────

function calculateTargets(
  sessionType: SessionType,
  athlete: Athlete,
  phase: Phase,
  weeklyHours: number
): SessionTargets {
  const durationByType: Record<string, number> = {
    long_run: weeklyHours * 0.35 * 3600,
    threshold: Math.min(weeklyHours * 0.20 * 3600, 3600),
    tempo: Math.min(weeklyHours * 0.18 * 3600, 3600),
    intervals: Math.min(weeklyHours * 0.18 * 3600, 3600),
    easy_run: weeklyHours * 0.22 * 3600,
    recovery: weeklyHours * 0.12 * 3600,
    race: 0,
  };

  const duration_s = Math.round(durationByType[sessionType] ?? weeklyHours * 0.20 * 3600);

  if (!athlete.threshold_pace) {
    return {
      duration_s,
      description: describeSession(sessionType),
    };
  }

  const [min, sec] = athlete.threshold_pace.split(':').map(Number);
  const thresholdSec = (min ?? 0) * 60 + (sec ?? 0);
  const paceTargets = buildPaceTargets(sessionType, thresholdSec);

  // Estimate distance from duration + midpoint pace
  let distance_m: number | undefined;
  if (paceTargets.pace_zone && duration_s > 0) {
    const paces = paceTargets.pace_zone.replace('/km', '').split('–');
    if (paces.length === 2) {
      const avgSec = paces.reduce((sum, p) => {
        const parts = p.split(':').map(Number);
        return sum + (parts[0]! * 60 + (parts[1] ?? 0));
      }, 0) / 2;
      distance_m = Math.round((duration_s / avgSec) * 1000);
    }
  }

  return { duration_s, distance_m, ...paceTargets };
}

// ─── Date scheduling ──────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0]!;
}

function scheduleInWeek(
  templates: SessionTemplate[],
  weekStartDate: string,
  availableDays: number
): Array<SessionTemplate & { date: string }> {
  // Pool of available day offsets for the week (Mon=0 … Sun=6)
  // Long run goes to Saturday (offset 5) or Sunday (offset 6) preferentially
  const allOffsets = [0, 1, 2, 3, 4, 5, 6].slice(0, 7);
  const usedOffsets = new Set<number>();
  const scheduled: Array<SessionTemplate & { date: string }> = [];

  // Sort: long_run first (to grab weekend), then hard sessions, then easy/recovery
  const sorted = [...templates].sort((a, b) => {
    const order: Record<string, number> = { long_run: 0, threshold: 1, intervals: 1, tempo: 2, easy_run: 3, recovery: 4, race: 0 };
    return (order[a.type] ?? 5) - (order[b.type] ?? 5);
  });

  for (const tmpl of sorted) {
    let chosenOffset = -1;

    if (tmpl.type === 'long_run') {
      // Prefer Saturday (5) then Sunday (6) then Friday (4)
      for (const pref of [5, 6, 4]) {
        if (!usedOffsets.has(pref)) { chosenOffset = pref; break; }
      }
    }

    if (chosenOffset === -1) {
      // Find next available slot, avoiding back-to-back hard
      for (const offset of allOffsets) {
        if (usedOffsets.has(offset)) continue;

        const isHard = (t: string) => t === 'threshold' || t === 'tempo' || t === 'intervals';
        if (isHard(tmpl.type)) {
          // Check adjacent days
          const adjacentUsed = scheduled.some(
            (s) => isHard(s.type) && Math.abs(s.date === addDays(weekStartDate, offset) ? 0 : 1)
          );
          // Simpler: check offsets ±1
          const prevBusy = scheduled.some((s) => isHard(s.type) && s.date === addDays(weekStartDate, offset - 1));
          const nextBusy = scheduled.some((s) => isHard(s.type) && s.date === addDays(weekStartDate, offset + 1));
          if (prevBusy || nextBusy) continue;
        }

        chosenOffset = offset;
        break;
      }
    }

    if (chosenOffset === -1) continue; // No slot found — skip session
    usedOffsets.add(chosenOffset);
    scheduled.push({ ...tmpl, date: addDays(weekStartDate, chosenOffset) });
  }

  return scheduled;
}

// ─── Rationale generation ─────────────────────────────────────────────────────

function getRationale(
  sessionType: SessionType,
  phase: Phase,
  weekNumber: number,
  targets: SessionTargets,
  goalType?: GoalType
): string {
  const goal = goalType ? goalType.replace('_', ' ') : 'your goal';
  const dist = targets.distance_m ? `${(targets.distance_m / 1000).toFixed(0)}km` : '';
  const pace = targets.pace_zone ?? '';

  const rationales: Record<string, string> = {
    long_run: `Long run builds your aerobic base and fat-burning capacity. ${dist ? `At ${dist}` : 'This distance'} you're developing the endurance needed for your ${goal}.`,
    threshold: `Threshold work at your lactate threshold pace improves your ability to hold race pace when tired. This is the key quality session of the week. ${pace ? `Target: ${pace}.` : ''}`,
    tempo: `Tempo running at comfortably-hard effort builds your lactate threshold and running economy. ${pace ? `Target: ${pace}.` : 'Run at a pace where you can only say a few words at a time.'}`,
    intervals: `Interval training at race pace and faster builds speed and VO2max. Hard efforts with recovery jogs between. ${pace ? `Target: ${pace}.` : ''}`,
    easy_run: `Easy run to accumulate aerobic volume without adding fatigue. ${pace ? `Keep the pace genuinely easy: ${pace}.` : 'This should feel comfortable — you should be able to hold a full conversation.'}`,
    recovery: `Easy recovery run after recent hard efforts. Keep it genuinely easy — this is how adaptation happens.`,
    race: `Race day — everything the plan has been building towards. Trust your training and run your race.`,
  };

  return rationales[sessionType] ?? `${sessionType} — ${phase} phase week ${weekNumber}.`;
}

// ─── Week generation ──────────────────────────────────────────────────────────

export function generateWeek(
  weekNumber: number,
  plan: Plan,
  athlete: Athlete,
  weekStartDate: string,
  phase: Phase,
  isRecovery: boolean,
  weeklyHours: number
): NewPlanSession[] {
  const constraints = plan.constraints ?? { available_days: 4, max_hours_per_week: 6, preferred_session_types: [], excluded_days: [] };
  const availableDays = constraints.available_days;
  const goalType = plan.goal_type as GoalType;

  let templates: SessionTemplate[];
  if (isRecovery) {
    templates = ([
      { type: 'long_run', priority: 'key' },
      { type: 'easy_run', priority: 'standard' },
      { type: 'recovery', priority: 'optional' },
    ] as SessionTemplate[]).slice(0, availableDays);
  } else if (phase === 'taper') {
    templates = getTaperTemplate(availableDays);
  } else {
    templates = getWeekTemplate(availableDays, phase);
  }

  const scheduledTemplates = scheduleInWeek(templates, weekStartDate, availableDays);

  return scheduledTemplates.map((tmpl) => {
    const targets = calculateTargets(tmpl.type, athlete, phase, weeklyHours);
    const rationale = getRationale(tmpl.type, phase, weekNumber, targets, goalType);

    return {
      id: crypto.randomUUID(),
      plan_id: plan.id,
      scheduled_date: tmpl.date,
      original_date: tmpl.date,
      week_number: weekNumber,
      session_type: tmpl.type,
      sport: 'run' as const,
      targets,
      rationale,
      priority: tmpl.priority,
      status: 'planned' as const,
      strava_activity_id: null,
    };
  });
}

// ─── Plan generation entry point ──────────────────────────────────────────────

export function generatePlan(
  plan: Plan,
  athlete: Athlete,
  latestSnapshot: AthleteSnapshot | null,
  startDate?: string  // ISO date — defaults to Monday of current week
): NewPlanSession[] {
  const goalType = plan.goal_type as GoalType;
  const ctl = latestSnapshot?.ctl ?? 30;
  const constraints = plan.constraints ?? { available_days: 4, max_hours_per_week: 6, preferred_session_types: [], excluded_days: [] };

  // Use provided start date or Monday of current week
  const anchor = startDate ? new Date(startDate) : new Date();
  if (!startDate) {
    const mondayOffset = anchor.getUTCDay() === 0 ? -6 : 1 - anchor.getUTCDay();
    anchor.setUTCDate(anchor.getUTCDate() + mondayOffset);
  }

  const goalDate = new Date(plan.goal_date);
  const totalWeeks = Math.ceil((goalDate.getTime() - anchor.getTime()) / (7 * 86400000));

  const baseFraction = startingHoursFraction(ctl);
  const baseHours = constraints.max_hours_per_week * baseFraction;

  const allSessions: NewPlanSession[] = [];
  const weekZeroMonday = anchor;

  for (let week = 1; week <= totalWeeks; week++) {
    const weekStart = new Date(weekZeroMonday);
    weekStart.setUTCDate(weekZeroMonday.getUTCDate() + (week - 1) * 7);
    const weekStartStr = weekStart.toISOString().split('T')[0]!;

    const phase = getPhase(week, totalWeeks, goalType);
    const recovery = isRecoveryWeek(week, ctl);
    const weeklyHours = calculateWeeklyHours(week, baseHours, phase, recovery);

    const sessions = generateWeek(week, plan, athlete, weekStartStr, phase, recovery, weeklyHours);
    allSessions.push(...sessions);
  }

  // Add race day session
  allSessions.push({
    id: crypto.randomUUID(),
    plan_id: plan.id,
    scheduled_date: plan.goal_date,
    original_date: plan.goal_date,
    week_number: totalWeeks,
    session_type: 'race',
    sport: 'run' as const,
    targets: {
      distance_m: RACE_DISTANCE_M[goalType],
      description: `Race day — ${plan.goal_description ?? goalType.replace('_', ' ')}. Trust your training.`,
    },
    rationale: `Race day — ${plan.goal_description ?? goalType.replace('_', ' ')}. This is what the whole plan has been building towards.`,
    priority: 'key',
    status: 'planned',
    strava_activity_id: null,
  });

  return allSessions;
}

// ─── Plan recommendation ──────────────────────────────────────────────────────

export function getPlanRecommendation(
  ctl: number,
  weeklyDistanceM: number,
  weeklyDurationS: number,
  recentSessionsPerWeek: number
): { suggested_days: number; suggested_hours: number; readiness: string } {
  const avgHoursPerWeek = weeklyDurationS / 3600;
  const suggested_hours = Math.max(4, Math.min(Math.round(avgHoursPerWeek * 1.1 * 2) / 2, 20));
  const suggested_days = Math.min(6, Math.max(3, Math.round(recentSessionsPerWeek)));

  let readiness: string;
  if (ctl < 20) readiness = 'low base — plan will start conservatively';
  else if (ctl < 40) readiness = 'moderate base — good starting point';
  else if (ctl < 60) readiness = 'solid base — ready for structured training';
  else readiness = 'strong base — can handle high training load';

  return { suggested_days, suggested_hours, readiness };
}
