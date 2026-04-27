import crypto from 'crypto';
import type { Plan, Athlete, AthleteSnapshot, NewPlanSession, PlanSession, SessionTargets } from '../db/schema';
import { buildPaceTargets, formatSec, describeSession } from './operations';

export type GoalType = '5k' | '10k' | 'half_marathon' | 'marathon';
export type Phase = 'base' | 'build' | 'peak' | 'taper';
export type SessionType = PlanSession['session_type'];

// ─── Phase lengths (canonical reference plan) ──────────────────────────────────

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

// Peak long run distances per goal type (achieved in final peak week)
const PEAK_LONG_RUN_M: Record<GoalType, number> = {
  '5k': 11000,
  '10k': 17000,
  'half_marathon': 21000,
  'marathon': 34000,
};

// ─── Volume calibration ────────────────────────────────────────────────────────

function startingHoursFraction(ctl: number): number {
  if (ctl < 30) return 0.50;
  if (ctl < 50) return 0.60;
  if (ctl < 70) return 0.70;
  return 0.80;
}

// ─── Phase calculation ─────────────────────────────────────────────────────────

interface PhaseInfo {
  phase: Phase;
  weekInPhase: number;  // 1-indexed position within this phase
  phaseLength: number;  // total weeks in this phase
}

// End-anchored phase scaling: taper and peak are always preserved at the end
// regardless of total plan length. Base and build absorb the compression.
export function getPhaseInfo(weekNumber: number, totalWeeks: number, goalType: GoalType): PhaseInfo {
  const phases = PHASE_WEEKS[goalType];
  if (!phases) return { phase: 'build', weekInPhase: weekNumber, phaseLength: totalWeeks };

  const standardTotal = phases.base + phases.build + phases.peak + phases.taper;
  const scale = totalWeeks / standardTotal;

  const taperWeeks = Math.max(1, Math.round(phases.taper * scale));
  const peakWeeks = Math.max(1, Math.round(phases.peak * scale));
  const remainingWeeks = Math.max(2, totalWeeks - taperWeeks - peakWeeks);
  const baseProportion = phases.base / (phases.base + phases.build);
  const baseWeeks = Math.max(1, Math.round(remainingWeeks * baseProportion));
  const buildWeeks = Math.max(1, remainingWeeks - baseWeeks);

  // End-anchored: count backward from totalWeeks
  const taperStart = totalWeeks - taperWeeks + 1;
  const peakStart = taperStart - peakWeeks;
  const buildStart = baseWeeks + 1;

  if (weekNumber >= taperStart) {
    return { phase: 'taper', weekInPhase: weekNumber - taperStart + 1, phaseLength: taperWeeks };
  }
  if (weekNumber >= peakStart) {
    return { phase: 'peak', weekInPhase: weekNumber - peakStart + 1, phaseLength: peakWeeks };
  }
  if (weekNumber >= buildStart) {
    return { phase: 'build', weekInPhase: weekNumber - buildStart + 1, phaseLength: buildWeeks };
  }
  return { phase: 'base', weekInPhase: weekNumber, phaseLength: baseWeeks };
}

export function getPhase(weekNumber: number, totalWeeks: number, goalType: GoalType): Phase {
  return getPhaseInfo(weekNumber, totalWeeks, goalType).phase;
}

export function isRecoveryWeek(weekNumber: number, ctl: number): boolean {
  const cycle = ctl >= 50 ? 4 : 3;
  return weekNumber % cycle === 0;
}

export function calculateWeeklyHours(
  weekNumber: number,
  totalWeeks: number,
  baseHours: number,
  phase: Phase,
  isRecovery: boolean
): number {
  if (isRecovery) return baseHours * 0.65;

  // Race week: always very light — athlete is resting before race day
  if (weekNumber === totalWeeks) return baseHours * 0.25;

  if (phase === 'taper') {
    // Step down toward race week. weeksFromEnd=1 is the last pre-race week.
    const weeksFromEnd = totalWeeks - weekNumber;
    const taperFactor = 0.65 + (weeksFromEnd - 1) * 0.15;
    const peakHours = baseHours * 1.3;
    return Math.min(peakHours, peakHours * Math.max(0.30, taperFactor));
  }

  if (phase === 'peak') return Math.min(baseHours * 1.3, baseHours * Math.pow(1.06, weekNumber - 1));

  // base/build: 6% per week progression
  return Math.min(baseHours * Math.pow(1.06, weekNumber - 1), baseHours * 1.5);
}

// ─── Session templates ─────────────────────────────────────────────────────────

interface SessionTemplate {
  type: SessionType;
  priority: PlanSession['priority'];
}

function getWeekTemplate(
  availableDays: number,
  phase: Phase,
  weekInPhase: number,
  phaseLength: number
): SessionTemplate[] {
  // Introduce intervals in the latter half of build phase; threshold in early build
  let hardSession: SessionType;
  if (phase === 'base') {
    hardSession = 'tempo';
  } else if (phase === 'build') {
    hardSession = weekInPhase > Math.ceil(phaseLength / 2) ? 'intervals' : 'threshold';
  } else {
    // peak
    hardSession = 'intervals';
  }

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

// Race week: easy runs only — no hard sessions, no long run
function getRaceWeekTemplate(availableDays: number): SessionTemplate[] {
  const sessions: SessionTemplate[] = [
    { type: 'easy_run', priority: 'standard' },
    { type: 'easy_run', priority: 'standard' },
  ];
  if (availableDays >= 4) sessions.push({ type: 'recovery', priority: 'optional' });
  return sessions;
}

// ─── Structured session prescriptions ─────────────────────────────────────────

const WARMUP_S = 600;   // 10 min
const COOLDOWN_S = 600; // 10 min

interface IntervalPrescription {
  reps: number;
  rep_distance_m: number;
  pace_offset_s: number; // seconds relative to threshold (negative = faster)
  recovery_s: number;
}

const INTERVAL_PRESCRIPTIONS: Partial<Record<GoalType, Partial<Record<'build' | 'peak', IntervalPrescription>>>> = {
  '5k':            { build: { reps: 6, rep_distance_m: 600,  pace_offset_s: -15, recovery_s: 90  },
                     peak:  { reps: 8, rep_distance_m: 600,  pace_offset_s: -20, recovery_s: 90  } },
  '10k':           { build: { reps: 6, rep_distance_m: 1000, pace_offset_s: -10, recovery_s: 90  },
                     peak:  { reps: 8, rep_distance_m: 1000, pace_offset_s: -15, recovery_s: 90  } },
  'half_marathon': { build: { reps: 5, rep_distance_m: 1600, pace_offset_s:  -5, recovery_s: 120 },
                     peak:  { reps: 6, rep_distance_m: 1000, pace_offset_s: -10, recovery_s: 90  } },
  'marathon':      { build: { reps: 6, rep_distance_m: 1000, pace_offset_s: +10, recovery_s: 90  },
                     peak:  { reps: 5, rep_distance_m: 1600, pace_offset_s:   0, recovery_s: 120 } },
};

function getLongRunDistance(
  goalType: GoalType,
  phase: Phase,
  weekInPhase: number,
  phaseLength: number
): number {
  const peak = PEAK_LONG_RUN_M[goalType];
  const progress = weekInPhase / phaseLength; // 0→1 through the phase

  switch (phase) {
    case 'base':  return Math.round(peak * (0.50 + progress * 0.15)); // 50–65%
    case 'build': return Math.round(peak * (0.65 + progress * 0.25)); // 65–90%
    case 'peak':  return Math.round(peak * (0.90 + progress * 0.10)); // 90–100%
    case 'taper': return Math.round(peak * Math.max(0.30, 0.70 - (weekInPhase - 1) * 0.20));
  }
}

export function buildSessionStructure(
  sessionType: SessionType,
  goalType: GoalType,
  phase: Phase,
  weekInPhase: number,
  phaseLength: number,
  thresholdSec: number
): Partial<SessionTargets> {
  if (sessionType === 'intervals') {
    const p = INTERVAL_PRESCRIPTIONS[goalType]?.[phase as 'build' | 'peak'];
    if (!p) return {};

    const repPaceSec = thresholdSec + p.pace_offset_s;
    const repDurationS = Math.round((p.rep_distance_m / 1000) * repPaceSec);
    const totalDurationS = WARMUP_S + p.reps * repDurationS + (p.reps - 1) * p.recovery_s + COOLDOWN_S;
    const repDistLabel = p.rep_distance_m >= 1000 ? `${p.rep_distance_m / 1000}km` : `${p.rep_distance_m}m`;
    const repPaceStr = formatSec(repPaceSec);
    const recoveryLabel = p.recovery_s % 60 === 0 ? `${p.recovery_s / 60}min` : `${p.recovery_s}s`;

    return {
      reps: p.reps,
      rep_distance_m: p.rep_distance_m,
      rep_pace: `${repPaceStr}/km`,
      recovery_s: p.recovery_s,
      recovery_type: 'jog',
      warmup_s: WARMUP_S,
      cooldown_s: COOLDOWN_S,
      duration_s: totalDurationS,
      description: `10min easy warm-up → ${p.reps}×${repDistLabel} @ ${repPaceStr}/km with ${recoveryLabel} recovery jog → 10min cool-down`,
    };
  }

  if (sessionType === 'threshold') {
    const thresholdPace = formatSec(thresholdSec);
    const isEarlyBuild = weekInPhase <= Math.ceil(phaseLength / 2);

    if (isEarlyBuild) {
      const repDurationS = 15 * 60; // 15min blocks
      const totalDurationS = WARMUP_S + 2 * repDurationS + 120 + COOLDOWN_S;
      return {
        reps: 2,
        rep_duration_s: repDurationS,
        rep_pace: `${thresholdPace}/km`,
        recovery_s: 120,
        recovery_type: 'jog',
        warmup_s: WARMUP_S,
        cooldown_s: COOLDOWN_S,
        duration_s: totalDurationS,
        description: `10min easy warm-up → 2×15min @ ${thresholdPace}/km with 2min recovery jog → 10min cool-down`,
      };
    } else {
      const blockDurationS = 25 * 60; // 25min continuous
      const totalDurationS = WARMUP_S + blockDurationS + COOLDOWN_S;
      return {
        reps: 1,
        rep_duration_s: blockDurationS,
        rep_pace: `${thresholdPace}/km`,
        warmup_s: WARMUP_S,
        cooldown_s: COOLDOWN_S,
        duration_s: totalDurationS,
        description: `10min easy warm-up → 25min continuous @ ${thresholdPace}/km → 10min cool-down`,
      };
    }
  }

  return {};
}

// ─── Target calculation ────────────────────────────────────────────────────────

function calculateTargets(
  sessionType: SessionType,
  athlete: Athlete,
  phase: Phase,
  weeklyHours: number,
  goalType: GoalType,
  weekInPhase: number,
  phaseLength: number
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

  const baseDuration_s = Math.round(durationByType[sessionType] ?? weeklyHours * 0.20 * 3600);

  if (!athlete.threshold_pace) {
    return {
      duration_s: baseDuration_s,
      description: describeSession(sessionType),
    };
  }

  const [min, sec] = athlete.threshold_pace.split(':').map(Number);
  const thresholdSec = (min ?? 0) * 60 + (sec ?? 0);
  const paceTargets = buildPaceTargets(sessionType, thresholdSec);

  // For intervals and threshold, overlay the structured prescription
  if (sessionType === 'intervals' || sessionType === 'threshold') {
    const structure = buildSessionStructure(sessionType, goalType, phase, weekInPhase, phaseLength, thresholdSec);
    if (Object.keys(structure).length > 0) {
      return { ...paceTargets, ...structure };
    }
  }

  // Long run: goal-type specific peak distance scaled by phase progress, not hours-derived
  if (sessionType === 'long_run') {
    const targetDistM = getLongRunDistance(goalType, phase, weekInPhase, phaseLength);
    const easyPaceSec = thresholdSec + 75; // midpoint of easy zone (threshold + 60–90s/km)
    const targetDurationS = Math.round((targetDistM / 1000) * easyPaceSec);
    return { distance_m: targetDistM, duration_s: targetDurationS, ...paceTargets };
  }

  // For other session types, estimate distance from duration + midpoint pace
  let distance_m: number | undefined;
  if (paceTargets.pace_zone && baseDuration_s > 0) {
    const paces = paceTargets.pace_zone.replace('/km', '').split('–');
    if (paces.length === 2) {
      const avgSec = paces.reduce((sum, p) => {
        const parts = p.split(':').map(Number);
        return sum + (parts[0]! * 60 + (parts[1] ?? 0));
      }, 0) / 2;
      distance_m = Math.round((baseDuration_s / avgSec) * 1000);
    }
  }

  return { duration_s: baseDuration_s, distance_m, ...paceTargets };
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
  availableDays: number,
  excludedDays: number[] = []
): Array<SessionTemplate & { date: string }> {
  const usedOffsets = new Set<number>();
  const excluded = new Set(excludedDays);
  const scheduled: Array<SessionTemplate & { date: string }> = [];
  const isHard = (t: string) => t === 'threshold' || t === 'tempo' || t === 'intervals';

  // Sort: long_run and race first (grab weekend), then hard sessions, then easy/recovery
  const sorted = [...templates].sort((a, b) => {
    const order: Record<string, number> = { long_run: 0, race: 0, threshold: 1, intervals: 1, tempo: 2, easy_run: 3, recovery: 4 };
    return (order[a.type] ?? 5) - (order[b.type] ?? 5);
  });

  for (const tmpl of sorted) {
    let chosenOffset = -1;

    if (tmpl.type === 'long_run') {
      // Prefer Saturday (5) then Sunday (6) then Friday (4)
      for (const pref of [5, 6, 4]) {
        if (!usedOffsets.has(pref) && !excluded.has(pref)) { chosenOffset = pref; break; }
      }
    } else if (isHard(tmpl.type)) {
      // Prefer Tue–Thu for hard sessions to keep them mid-week and away from Monday and the long run
      for (const offset of [2, 3, 1, 4, 0, 5, 6]) {
        if (usedOffsets.has(offset) || excluded.has(offset)) continue;
        const prevHard = scheduled.some((s) => isHard(s.type) && s.date === addDays(weekStartDate, offset - 1));
        const nextHard = scheduled.some((s) => isHard(s.type) && s.date === addDays(weekStartDate, offset + 1));
        const adjLong = scheduled.some((s) => s.type === 'long_run' && (
          s.date === addDays(weekStartDate, offset - 1) || s.date === addDays(weekStartDate, offset + 1)
        ));
        if (prevHard || nextHard || adjLong) continue;
        chosenOffset = offset;
        break;
      }
    }

    if (chosenOffset === -1) {
      // Easy/recovery: any remaining non-excluded slot
      for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
        if (!usedOffsets.has(offset) && !excluded.has(offset)) { chosenOffset = offset; break; }
      }
    }

    if (chosenOffset === -1) continue;
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
  totalWeeks: number,
  plan: Plan,
  athlete: Athlete,
  weekStartDate: string,
  phase: Phase,
  isRecovery: boolean,
  weeklyHours: number
): NewPlanSession[] {
  const constraints = plan.constraints ?? { available_days: 4, max_hours_per_week: 6, preferred_session_types: [], excluded_days: [] };
  const availableDays = constraints.available_days;
  const excludedDays = constraints.excluded_days ?? [];
  const goalType = plan.goal_type as GoalType;

  // Always compute phase position — needed for structured target calculation
  const { weekInPhase, phaseLength } = getPhaseInfo(weekNumber, totalWeeks, goalType);

  let templates: SessionTemplate[];

  if (weekNumber === totalWeeks) {
    // Race week: easy runs only — athlete is resting before race day
    templates = getRaceWeekTemplate(availableDays);
  } else if (isRecovery) {
    templates = ([
      { type: 'long_run', priority: 'key' },
      { type: 'easy_run', priority: 'standard' },
      { type: 'recovery', priority: 'optional' },
    ] as SessionTemplate[]).slice(0, availableDays);
  } else if (phase === 'taper') {
    templates = getTaperTemplate(availableDays);
  } else {
    templates = getWeekTemplate(availableDays, phase, weekInPhase, phaseLength);
  }

  const scheduledTemplates = scheduleInWeek(templates, weekStartDate, availableDays, excludedDays);

  return scheduledTemplates.map((tmpl) => {
    const targets = calculateTargets(tmpl.type, athlete, phase, weeklyHours, goalType, weekInPhase, phaseLength);
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
  startDate?: string
): NewPlanSession[] {
  const goalType = plan.goal_type as GoalType;
  const ctl = latestSnapshot?.ctl ?? 30;
  const constraints = plan.constraints ?? { available_days: 4, max_hours_per_week: 6, preferred_session_types: [], excluded_days: [] };

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
    // Never treat race week as a recovery week
    const recovery = isRecoveryWeek(week, ctl) && week !== totalWeeks;
    const weeklyHours = calculateWeeklyHours(week, totalWeeks, baseHours, phase, recovery);

    const sessions = generateWeek(week, totalWeeks, plan, athlete, weekStartStr, phase, recovery, weeklyHours);
    allSessions.push(...sessions);
  }

  // Race day session on goal_date
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
