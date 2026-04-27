import type { PlanSession, SessionTargets, Athlete } from '../db/schema';

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

export function isHardSession(type: PlanSession['session_type']): boolean {
  return type === 'threshold' || type === 'tempo' || type === 'intervals';
}

function datesAreAdjacent(dateA: string, dateB: string): boolean {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs(a - b) === 86400000;
}

export function validateNoBackToBackHard(sessions: PlanSession[], changed: PlanSession): void {
  if (!isHardSession(changed.session_type)) return;
  const others = sessions.filter((s) => s.id !== changed.id && isHardSession(s.session_type));
  for (const other of others) {
    if (datesAreAdjacent(changed.scheduled_date, other.scheduled_date)) {
      throw new ConstraintError(
        `Cannot schedule ${changed.session_type} on ${changed.scheduled_date} — it would be back-to-back with the ${other.session_type} on ${other.scheduled_date}. Move one of the sessions to a different day.`
      );
    }
  }
}

function validateLongRunConstraints(sessions: PlanSession[], changed: PlanSession): void {
  const dayAfter = new Date(changed.scheduled_date);
  dayAfter.setDate(dayAfter.getDate() + 1);
  const dayAfterStr = dayAfter.toISOString().split('T')[0];

  const dayBefore = new Date(changed.scheduled_date);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const dayBeforeStr = dayBefore.toISOString().split('T')[0];

  for (const s of sessions) {
    if (s.id === changed.id) continue;
    if (changed.session_type === 'long_run') {
      if (isHardSession(s.session_type) && s.scheduled_date === dayAfterStr) {
        throw new ConstraintError(
          `Long run on ${changed.scheduled_date} cannot be followed by a hard session (${s.session_type}) the next day.`
        );
      }
      if (isHardSession(s.session_type) && s.scheduled_date === dayBeforeStr) {
        throw new ConstraintError(
          `Long run on ${changed.scheduled_date} cannot be preceded by a hard session (${s.session_type}) the day before.`
        );
      }
    }
    if (s.session_type === 'long_run' && isHardSession(changed.session_type)) {
      if (s.scheduled_date === dayAfterStr) {
        throw new ConstraintError(
          `Cannot schedule ${changed.session_type} on ${changed.scheduled_date} — the long run follows the next day.`
        );
      }
    }
  }
}

export function swapSessions(
  a: PlanSession,
  b: PlanSession,
  allSessions: PlanSession[]
): [PlanSession, PlanSession] {
  const updatedA = { ...a, scheduled_date: b.scheduled_date };
  const updatedB = { ...b, scheduled_date: a.scheduled_date };

  const otherSessions = allSessions.filter((s) => s.id !== a.id && s.id !== b.id);
  validateNoBackToBackHard([...otherSessions, updatedB], updatedA);
  validateNoBackToBackHard([...otherSessions, updatedA], updatedB);
  validateLongRunConstraints([...otherSessions, updatedB], updatedA);
  validateLongRunConstraints([...otherSessions, updatedA], updatedB);

  return [updatedA, updatedB];
}

export function moveSession(
  session: PlanSession,
  newDate: string,
  allSessions: PlanSession[]
): PlanSession {
  const updated = { ...session, scheduled_date: newDate };
  const others = allSessions.filter((s) => s.id !== session.id);
  validateNoBackToBackHard(others, updated);
  validateLongRunConstraints(others, updated);
  return updated;
}

export function skipSession(session: PlanSession, reason?: string): PlanSession {
  return {
    ...session,
    status: 'skipped',
  };
}

export function replaceSession(
  session: PlanSession,
  newType: PlanSession['session_type'],
  athlete: Athlete
): PlanSession {
  return {
    ...session,
    session_type: newType,
    targets: buildReplacementTargets(newType, athlete),
  };
}

function buildReplacementTargets(type: PlanSession['session_type'], athlete: Athlete): SessionTargets {
  if (!athlete.threshold_pace) {
    return { description: describeSession(type) };
  }
  const [min, sec] = athlete.threshold_pace.split(':').map(Number);
  const thresholdSec = min * 60 + sec;
  return buildPaceTargets(type, thresholdSec);
}

function buildPaceTargets(type: PlanSession['session_type'], thresholdSec: number): SessionTargets {
  const zone: Record<string, { lo: number; hi: number }> = {
    recovery: { lo: thresholdSec + 90, hi: thresholdSec + 120 },
    easy_run:  { lo: thresholdSec + 60, hi: thresholdSec + 90 },
    long_run:  { lo: thresholdSec + 60, hi: thresholdSec + 90 },
    tempo:     { lo: thresholdSec + 20, hi: thresholdSec + 40 },
    threshold: { lo: thresholdSec - 10, hi: thresholdSec + 10 },
    intervals: { lo: thresholdSec - 30, hi: thresholdSec - 15 },
  };
  const z = zone[type];
  if (!z) return { description: describeSession(type) };
  return {
    pace_zone: `${formatSec(z.lo)}–${formatSec(z.hi)}/km`,
    description: describeSession(type),
  };
}

function formatSec(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function describeSession(type: PlanSession['session_type']): string {
  const descriptions: Record<string, string> = {
    easy_run: 'Easy conversational pace — you should be able to hold a full conversation',
    long_run: 'Easy aerobic pace — comfortable and sustainable for the full duration',
    recovery: 'Very easy recovery pace — slower than easy, just keep moving',
    tempo: 'Comfortably hard — you can speak a few words but not a full sentence',
    threshold: 'Lactate threshold pace — hard effort you can sustain for ~60 minutes',
    intervals: 'Hard race-pace efforts with recovery jogs between',
    race: 'Race pace — give everything you have',
  };
  return descriptions[type] ?? type;
}

export function compressWeek(sessions: PlanSession[], maxSessions: number): PlanSession[] {
  if (sessions.length <= maxSessions) return sessions;

  const key = sessions.filter((s) => s.priority === 'key');
  const standard = sessions.filter((s) => s.priority === 'standard');
  const optional = sessions.filter((s) => s.priority === 'optional');

  const result: PlanSession[] = [...key];
  const remaining = maxSessions - result.length;

  const skippedOptional = optional.map((s) => ({ ...s, status: 'skipped' as const }));
  const skippedStandard: PlanSession[] = [];

  for (const s of standard) {
    if (result.length < maxSessions) {
      result.push(s);
    } else {
      skippedStandard.push({ ...s, status: 'skipped' as const });
    }
  }

  return [...result, ...skippedOptional, ...skippedStandard];
}

export function rescaleWeek(sessions: PlanSession[], loadFactor: number): PlanSession[] {
  return sessions.map((s) => {
    if (!s.targets) return s;
    const targets: SessionTargets = { ...s.targets };
    if (targets.distance_m) targets.distance_m = Math.round(targets.distance_m * loadFactor);
    if (targets.duration_s) targets.duration_s = Math.round(targets.duration_s * loadFactor);
    return { ...s, targets };
  });
}

export function completeSession(session: PlanSession, stravaActivityId: string): PlanSession {
  return {
    ...session,
    status: 'completed',
    strava_activity_id: stravaActivityId,
  };
}

// Re-export for use in plan.ts
export { buildPaceTargets, formatSec, describeSession };
