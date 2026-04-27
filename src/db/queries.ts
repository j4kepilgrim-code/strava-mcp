import { db } from './client';
import type {
  Athlete, NewAthlete,
  Activity, NewActivity,
  AthleteSnapshot, NewAthleteSnapshot,
  Plan, NewPlan,
  PlanSession, NewPlanSession,
  SessionEdit, NewSessionEdit,
} from './schema';

// ─── Athlete ─────────────────────────────────────────────────────────────────

export async function upsertAthlete(athlete: NewAthlete): Promise<Athlete> {
  const { data, error } = await db
    .from('athlete')
    .upsert({ ...athlete, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Athlete;
}

export async function getAthleteById(id: string): Promise<Athlete | null> {
  const { data, error } = await db
    .from('athlete')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Athlete | null;
}

export async function getAthleteByStravaId(stravaId: string): Promise<Athlete | null> {
  const { data, error } = await db
    .from('athlete')
    .select()
    .eq('strava_id', stravaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Athlete | null;
}

// ─── Activities ───────────────────────────────────────────────────────────────

export async function upsertActivities(activities: NewActivity[]): Promise<void> {
  if (activities.length === 0) return;
  const { error } = await db
    .from('activities')
    .upsert(activities, { onConflict: 'strava_id' });
  if (error) throw new Error(error.message);
}

export async function getActivities(
  athleteId: string,
  afterDate: string,
  sport?: string
): Promise<Activity[]> {
  let query = db
    .from('activities')
    .select()
    .eq('athlete_id', athleteId)
    .gte('activity_date', afterDate)
    .order('activity_date', { ascending: false });

  if (sport) query = query.eq('sport_type', sport);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Activity[];
}

export async function getActivityById(id: string): Promise<Activity | null> {
  const { data, error } = await db
    .from('activities')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Activity | null;
}

export async function getActivityByStravaId(stravaId: string): Promise<Activity | null> {
  const { data, error } = await db
    .from('activities')
    .select()
    .eq('strava_id', stravaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Activity | null;
}

export async function updateActivitySportData(id: string, sportData: unknown): Promise<void> {
  const { error } = await db
    .from('activities')
    .update({ sport_data: sportData })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function getMostRecentActivityDate(athleteId: string): Promise<string | null> {
  const { data, error } = await db
    .from('activities')
    .select('synced_at')
    .eq('athlete_id', athleteId)
    .order('activity_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data as { synced_at: string }).synced_at : null;
}

// ─── Athlete Snapshots ────────────────────────────────────────────────────────

export async function insertSnapshot(snapshot: NewAthleteSnapshot): Promise<AthleteSnapshot> {
  const { data, error } = await db
    .from('athlete_snapshots')
    .insert(snapshot)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as AthleteSnapshot;
}

export async function getLatestSnapshot(athleteId: string): Promise<AthleteSnapshot | null> {
  const { data, error } = await db
    .from('athlete_snapshots')
    .select()
    .eq('athlete_id', athleteId)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as AthleteSnapshot | null;
}

export async function getSnapshots(athleteId: string, weeks: number): Promise<AthleteSnapshot[]> {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - weeks * 7);
  const { data, error } = await db
    .from('athlete_snapshots')
    .select()
    .eq('athlete_id', athleteId)
    .gte('snapshot_date', afterDate.toISOString().split('T')[0])
    .order('snapshot_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AthleteSnapshot[];
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export async function insertPlan(plan: NewPlan): Promise<Plan> {
  const { data, error } = await db
    .from('plans')
    .insert(plan)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Plan;
}

export async function getActivePlan(athleteId: string): Promise<Plan | null> {
  const { data, error } = await db
    .from('plans')
    .select()
    .eq('athlete_id', athleteId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Plan | null;
}

export async function updatePlanStatus(planId: string, status: Plan['status']): Promise<void> {
  const { error } = await db
    .from('plans')
    .update({ status })
    .eq('id', planId);
  if (error) throw new Error(error.message);
}

// ─── Plan Sessions ────────────────────────────────────────────────────────────

export async function insertPlanSessions(sessions: NewPlanSession[]): Promise<PlanSession[]> {
  if (sessions.length === 0) return [];
  const { data, error } = await db
    .from('plan_sessions')
    .insert(sessions)
    .select();
  if (error) throw new Error(error.message);
  return (data ?? []) as PlanSession[];
}

export async function getSessionsByPlanId(planId: string): Promise<PlanSession[]> {
  const { data, error } = await db
    .from('plan_sessions')
    .select()
    .eq('plan_id', planId)
    .order('scheduled_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlanSession[];
}

export async function getSessionsByWeek(planId: string, weekNumber: number): Promise<PlanSession[]> {
  const { data, error } = await db
    .from('plan_sessions')
    .select()
    .eq('plan_id', planId)
    .eq('week_number', weekNumber)
    .order('scheduled_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlanSession[];
}

export async function getSessionById(id: string): Promise<PlanSession | null> {
  const { data, error } = await db
    .from('plan_sessions')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as PlanSession | null;
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<PlanSession, 'id' | 'plan_id' | 'original_date' | 'created_at'>>
): Promise<PlanSession> {
  const { data, error } = await db
    .from('plan_sessions')
    .update(updates)
    .eq('id', sessionId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as PlanSession;
}

// ─── Session Edits (append-only) ─────────────────────────────────────────────

export async function insertSessionEdit(edit: NewSessionEdit): Promise<SessionEdit> {
  const { data, error } = await db
    .from('session_edits')
    .insert(edit)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as SessionEdit;
}

export async function getSessionEdits(sessionId: string): Promise<SessionEdit[]> {
  const { data, error } = await db
    .from('session_edits')
    .select()
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SessionEdit[];
}
