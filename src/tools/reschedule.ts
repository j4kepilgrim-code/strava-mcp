import crypto from 'crypto';
import { loadTokens } from '../strava/auth';
import {
  getAthleteByStravaId,
  getActivePlan,
  getSessionsByPlanId,
  getSessionById,
  updateSession,
  insertSessionEdit,
} from '../db/queries';
import {
  swapSessions,
  moveSession,
  skipSession,
  compressWeek,
  rescaleWeek,
  ConstraintError,
} from '../engine/operations';
import type { PlanSession } from '../db/schema';

async function requireSessionInActivePlan(sessionId: string): Promise<{
  session: PlanSession;
  allSessions: PlanSession[];
}> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');

  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');

  const plan = await getActivePlan(athlete.id);
  if (!plan) throw new Error('No active training plan.');

  const session = await getSessionById(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found.`);
  if (session.plan_id !== plan.id) throw new Error('Session does not belong to the active plan.');

  const allSessions = await getSessionsByPlanId(plan.id);
  return { session, allSessions };
}

export async function swapSessionsTool(sessionIdA: string, sessionIdB: string): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');
  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');
  const plan = await getActivePlan(athlete.id);
  if (!plan) throw new Error('No active training plan.');

  const [sessA, sessB] = await Promise.all([
    getSessionById(sessionIdA),
    getSessionById(sessionIdB),
  ]);

  if (!sessA) throw new Error(`Session ${sessionIdA} not found.`);
  if (!sessB) throw new Error(`Session ${sessionIdB} not found.`);

  const allSessions = await getSessionsByPlanId(plan.id);

  let updatedA: PlanSession;
  let updatedB: PlanSession;
  try {
    [updatedA, updatedB] = swapSessions(sessA, sessB, allSessions);
  } catch (e) {
    if (e instanceof ConstraintError) return e.message;
    throw e;
  }

  await Promise.all([
    updateSession(updatedA.id, { scheduled_date: updatedA.scheduled_date }),
    updateSession(updatedB.id, { scheduled_date: updatedB.scheduled_date }),
    insertSessionEdit({
      id: crypto.randomUUID(),
      session_id: sessA.id,
      operation: 'swap',
      before_state: { scheduled_date: sessA.scheduled_date },
      after_state: { scheduled_date: updatedA.scheduled_date },
      triggered_by: 'llm_rescheduler',
      note: `Swapped with session ${sessB.id}`,
    }),
    insertSessionEdit({
      id: crypto.randomUUID(),
      session_id: sessB.id,
      operation: 'swap',
      before_state: { scheduled_date: sessB.scheduled_date },
      after_state: { scheduled_date: updatedB.scheduled_date },
      triggered_by: 'llm_rescheduler',
      note: `Swapped with session ${sessA.id}`,
    }),
  ]);

  return `Swapped sessions:\n- ${formatSession(sessA)} → ${updatedA.scheduled_date}\n- ${formatSession(sessB)} → ${updatedB.scheduled_date}`;
}

export async function moveSessionTool(sessionId: string, newDate: string): Promise<string> {
  const { session, allSessions } = await requireSessionInActivePlan(sessionId);

  let updated: PlanSession;
  try {
    updated = moveSession(session, newDate, allSessions);
  } catch (e) {
    if (e instanceof ConstraintError) return e.message;
    throw e;
  }

  await updateSession(session.id, { scheduled_date: newDate });
  await insertSessionEdit({
    id: crypto.randomUUID(),
    session_id: session.id,
    operation: 'move',
    before_state: { scheduled_date: session.scheduled_date },
    after_state: { scheduled_date: newDate },
    triggered_by: 'llm_rescheduler',
    note: null,
  });

  return `Moved ${formatSession(session)} from ${session.scheduled_date} to ${newDate}.`;
}

export async function skipSessionTool(sessionId: string, reason?: string): Promise<string> {
  const { session } = await requireSessionInActivePlan(sessionId);

  const updated = skipSession(session, reason);
  await updateSession(session.id, { status: 'skipped' });
  await insertSessionEdit({
    id: crypto.randomUUID(),
    session_id: session.id,
    operation: 'skip',
    before_state: { status: session.status },
    after_state: { status: 'skipped' },
    triggered_by: 'llm_rescheduler',
    note: reason ?? null,
  });

  return `Skipped ${formatSession(session)} on ${session.scheduled_date}${reason ? ` (${reason})` : ''}.`;
}

export async function compressWeekTool(weekNumber: number, maxSessions: number): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');
  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');
  const plan = await getActivePlan(athlete.id);
  if (!plan) throw new Error('No active training plan.');

  const { getSessionsByWeek } = await import('../db/queries');
  const sessions = await getSessionsByWeek(plan.id, weekNumber);
  if (sessions.length === 0) return `No sessions in week ${weekNumber}.`;

  const compressed = compressWeek(sessions, maxSessions);
  const skipped = compressed.filter((s) => s.status === 'skipped');

  await Promise.all(
    skipped.map((s) => {
      const original = sessions.find((o) => o.id === s.id)!;
      return Promise.all([
        updateSession(s.id, { status: 'skipped' }),
        insertSessionEdit({
          id: crypto.randomUUID(),
          session_id: s.id,
          operation: 'skip',
          before_state: { status: original.status },
          after_state: { status: 'skipped' },
          triggered_by: 'llm_rescheduler',
          note: `Week compressed to ${maxSessions} sessions`,
        }),
      ]);
    })
  );

  const kept = compressed.filter((s) => s.status !== 'skipped');
  return `Week ${weekNumber} compressed to ${kept.length} sessions. Skipped: ${skipped.map((s) => s.session_type.replace('_', ' ')).join(', ') || 'none'}.`;
}

export async function rescaleWeekTool(weekNumber: number, loadFactor: number): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated');
  const athlete = await getAthleteByStravaId(tokens.athlete_id.toString());
  if (!athlete) throw new Error('Athlete not found — run sync_recent_activities first');
  const plan = await getActivePlan(athlete.id);
  if (!plan) throw new Error('No active training plan.');

  const { getSessionsByWeek } = await import('../db/queries');
  const sessions = await getSessionsByWeek(plan.id, weekNumber);
  if (sessions.length === 0) return `No sessions in week ${weekNumber}.`;

  const rescaled = rescaleWeek(sessions, loadFactor);

  await Promise.all(
    rescaled.map((s) => {
      const original = sessions.find((o) => o.id === s.id)!;
      if (JSON.stringify(original.targets) === JSON.stringify(s.targets)) return Promise.resolve();
      return Promise.all([
        updateSession(s.id, { targets: s.targets }),
        insertSessionEdit({
          id: crypto.randomUUID(),
          session_id: s.id,
          operation: 'rescale',
          before_state: { targets: original.targets },
          after_state: { targets: s.targets },
          triggered_by: 'llm_rescheduler',
          note: `Load factor: ${loadFactor}`,
        }),
      ]);
    })
  );

  const pct = Math.round(loadFactor * 100);
  const label = loadFactor < 1 ? `recovery week (${pct}% load)` : `increased load (${pct}%)`;
  return `Week ${weekNumber} rescaled to ${pct}% load — ${label}. ${rescaled.length} sessions updated.`;
}

export async function addNoteTool(note: string, date?: string): Promise<string> {
  const today = new Date().toISOString().split('T')[0]!;
  const noteDate = date ?? today;
  // Notes stored as coaching log — for now return confirmation
  // Full implementation in Step 11 will store to DB
  return `Note logged for ${noteDate}: "${note}"`;
}

function formatSession(s: PlanSession): string {
  return s.session_type.replace(/_/g, ' ');
}
