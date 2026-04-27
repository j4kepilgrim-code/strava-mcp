import { db } from './client';
import type {
  Athlete, NewAthlete,
  Activity, NewActivity,
  AthleteSnapshot, NewAthleteSnapshot,
  Plan, NewPlan,
  PlanSession, NewPlanSession,
  SessionEdit, NewSessionEdit,
} from './schema';

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function toJson(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function fromJson<T>(v: unknown): T | null {
  if (!v || typeof v !== 'string') return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function mapAthlete(row: Record<string, unknown>): Athlete {
  return row as unknown as Athlete;
}

function mapActivity(row: Record<string, unknown>): Activity {
  return {
    ...row,
    sport_data: fromJson(row['sport_data']),
  } as unknown as Activity;
}

function mapSnapshot(row: Record<string, unknown>): AthleteSnapshot {
  return {
    ...row,
    sport_split: fromJson(row['sport_split']),
  } as unknown as AthleteSnapshot;
}

function mapPlan(row: Record<string, unknown>): Plan {
  return {
    ...row,
    constraints: fromJson(row['constraints']),
  } as unknown as Plan;
}

function mapSession(row: Record<string, unknown>): PlanSession {
  return {
    ...row,
    targets: fromJson(row['targets']),
  } as unknown as PlanSession;
}

function mapEdit(row: Record<string, unknown>): SessionEdit {
  return {
    ...row,
    before_state: fromJson(row['before_state']),
    after_state: fromJson(row['after_state']),
  } as unknown as SessionEdit;
}

// ─── Athlete ─────────────────────────────────────────────────────────────────

export async function upsertAthlete(athlete: NewAthlete): Promise<Athlete> {
  db.prepare(`
    INSERT INTO athlete (id, name, strava_id, weight_kg, ftp_watts, threshold_pace, css_per_100m, vo2max_estimate, updated_at)
    VALUES (@id, @name, @strava_id, @weight_kg, @ftp_watts, @threshold_pace, @css_per_100m, @vo2max_estimate, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      strava_id = excluded.strava_id,
      weight_kg = excluded.weight_kg,
      ftp_watts = excluded.ftp_watts,
      threshold_pace = excluded.threshold_pace,
      css_per_100m = excluded.css_per_100m,
      vo2max_estimate = excluded.vo2max_estimate,
      updated_at = datetime('now')
  `).run(athlete);

  return mapAthlete(db.prepare('SELECT * FROM athlete WHERE id = ?').get(athlete.id) as Record<string, unknown>);
}

export async function getAthleteById(id: string): Promise<Athlete | null> {
  const row = db.prepare('SELECT * FROM athlete WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapAthlete(row) : null;
}

export async function getAthleteByStravaId(stravaId: string): Promise<Athlete | null> {
  const row = db.prepare('SELECT * FROM athlete WHERE strava_id = ?').get(stravaId) as Record<string, unknown> | undefined;
  return row ? mapAthlete(row) : null;
}

// ─── Activities ───────────────────────────────────────────────────────────────

export async function upsertActivities(activities: NewActivity[]): Promise<void> {
  if (activities.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO activities (id, strava_id, athlete_id, sport_type, activity_date, distance_m, moving_time_s,
      elapsed_time_s, elevation_gain_m, avg_hr, max_hr, suffer_score, perceived_effort, sport_data, synced_at)
    VALUES (@id, @strava_id, @athlete_id, @sport_type, @activity_date, @distance_m, @moving_time_s,
      @elapsed_time_s, @elevation_gain_m, @avg_hr, @max_hr, @suffer_score, @perceived_effort, @sport_data, datetime('now'))
    ON CONFLICT(strava_id) DO UPDATE SET
      sport_type = excluded.sport_type,
      activity_date = excluded.activity_date,
      distance_m = excluded.distance_m,
      moving_time_s = excluded.moving_time_s,
      elapsed_time_s = excluded.elapsed_time_s,
      elevation_gain_m = excluded.elevation_gain_m,
      avg_hr = excluded.avg_hr,
      max_hr = excluded.max_hr,
      suffer_score = excluded.suffer_score,
      perceived_effort = excluded.perceived_effort,
      sport_data = excluded.sport_data,
      synced_at = datetime('now')
  `);
  const upsertMany = db.transaction((rows: NewActivity[]) => {
    for (const a of rows) stmt.run({ ...a, sport_data: toJson(a.sport_data) });
  });
  upsertMany(activities);
}

export async function getActivities(
  athleteId: string,
  afterDate: string,
  sport?: string
): Promise<Activity[]> {
  const rows = sport
    ? db.prepare('SELECT * FROM activities WHERE athlete_id = ? AND activity_date >= ? AND sport_type = ? ORDER BY activity_date DESC').all(athleteId, afterDate, sport)
    : db.prepare('SELECT * FROM activities WHERE athlete_id = ? AND activity_date >= ? ORDER BY activity_date DESC').all(athleteId, afterDate);
  return (rows as Record<string, unknown>[]).map(mapActivity);
}

export async function getActivityById(id: string): Promise<Activity | null> {
  const row = db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapActivity(row) : null;
}

export async function getActivityByStravaId(stravaId: string): Promise<Activity | null> {
  const row = db.prepare('SELECT * FROM activities WHERE strava_id = ?').get(stravaId) as Record<string, unknown> | undefined;
  return row ? mapActivity(row) : null;
}

export async function updateActivitySportData(id: string, sportData: unknown): Promise<void> {
  db.prepare('UPDATE activities SET sport_data = ? WHERE id = ?').run(toJson(sportData), id);
}

export async function getMostRecentActivityDate(athleteId: string): Promise<string | null> {
  const row = db.prepare('SELECT synced_at FROM activities WHERE athlete_id = ? ORDER BY activity_date DESC LIMIT 1').get(athleteId) as { synced_at: string } | undefined;
  return row?.synced_at ?? null;
}

// ─── Athlete Snapshots ────────────────────────────────────────────────────────

export async function insertSnapshot(snapshot: NewAthleteSnapshot): Promise<AthleteSnapshot> {
  db.prepare(`
    INSERT INTO athlete_snapshots (id, athlete_id, snapshot_date, weekly_distance_m, weekly_elevation_m,
      weekly_duration_s, ctl, atl, tsb, sport_split, notes)
    VALUES (@id, @athlete_id, @snapshot_date, @weekly_distance_m, @weekly_elevation_m,
      @weekly_duration_s, @ctl, @atl, @tsb, @sport_split, @notes)
  `).run({ ...snapshot, sport_split: toJson(snapshot.sport_split) });

  const row = db.prepare('SELECT * FROM athlete_snapshots WHERE id = ?').get(snapshot.id) as Record<string, unknown>;
  return mapSnapshot(row);
}

export async function getLatestSnapshot(athleteId: string): Promise<AthleteSnapshot | null> {
  const row = db.prepare('SELECT * FROM athlete_snapshots WHERE athlete_id = ? ORDER BY snapshot_date DESC LIMIT 1').get(athleteId) as Record<string, unknown> | undefined;
  return row ? mapSnapshot(row) : null;
}

export async function getSnapshots(athleteId: string, weeks: number): Promise<AthleteSnapshot[]> {
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - weeks * 7);
  const rows = db.prepare('SELECT * FROM athlete_snapshots WHERE athlete_id = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC').all(athleteId, afterDate.toISOString().split('T')[0]!);
  return (rows as Record<string, unknown>[]).map(mapSnapshot);
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export async function insertPlan(plan: NewPlan): Promise<Plan> {
  db.prepare(`
    INSERT INTO plans (id, athlete_id, goal_type, goal_date, goal_description, status, constraints)
    VALUES (@id, @athlete_id, @goal_type, @goal_date, @goal_description, @status, @constraints)
  `).run({ ...plan, constraints: toJson(plan.constraints) });

  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id) as Record<string, unknown>;
  return mapPlan(row);
}

export async function getActivePlan(athleteId: string): Promise<Plan | null> {
  const row = db.prepare("SELECT * FROM plans WHERE athlete_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(athleteId) as Record<string, unknown> | undefined;
  return row ? mapPlan(row) : null;
}

export async function updatePlanStatus(planId: string, status: Plan['status']): Promise<void> {
  db.prepare('UPDATE plans SET status = ? WHERE id = ?').run(status, planId);
}

// ─── Plan Sessions ────────────────────────────────────────────────────────────

export async function insertPlanSessions(sessions: NewPlanSession[]): Promise<PlanSession[]> {
  if (sessions.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO plan_sessions (id, plan_id, scheduled_date, original_date, week_number, session_type,
      sport, targets, rationale, priority, status, strava_activity_id)
    VALUES (@id, @plan_id, @scheduled_date, @original_date, @week_number, @session_type,
      @sport, @targets, @rationale, @priority, @status, @strava_activity_id)
  `);
  const insertMany = db.transaction((rows: NewPlanSession[]) => {
    for (const s of rows) stmt.run({ ...s, targets: toJson(s.targets) });
  });
  insertMany(sessions);

  const ids = sessions.map((s) => `'${s.id}'`).join(',');
  const rows = db.prepare(`SELECT * FROM plan_sessions WHERE id IN (${ids}) ORDER BY scheduled_date ASC`).all() as Record<string, unknown>[];
  return rows.map(mapSession);
}

export async function getSessionsByPlanId(planId: string): Promise<PlanSession[]> {
  const rows = db.prepare('SELECT * FROM plan_sessions WHERE plan_id = ? ORDER BY scheduled_date ASC').all(planId) as Record<string, unknown>[];
  return rows.map(mapSession);
}

export async function getSessionsByWeek(planId: string, weekNumber: number): Promise<PlanSession[]> {
  const rows = db.prepare('SELECT * FROM plan_sessions WHERE plan_id = ? AND week_number = ? ORDER BY scheduled_date ASC').all(planId, weekNumber) as Record<string, unknown>[];
  return rows.map(mapSession);
}

export async function getSessionById(id: string): Promise<PlanSession | null> {
  const row = db.prepare('SELECT * FROM plan_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapSession(row) : null;
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<PlanSession, 'id' | 'plan_id' | 'original_date' | 'created_at'>>
): Promise<PlanSession> {
  const jsonFields = new Set(['targets']);
  const entries = Object.entries(updates);
  if (entries.length === 0) return (await getSessionById(sessionId))!;

  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([k, v]) => jsonFields.has(k) ? toJson(v) : v);

  db.prepare(`UPDATE plan_sessions SET ${sets} WHERE id = ?`).run([...values, sessionId]);
  return (await getSessionById(sessionId))!;
}

// ─── Session Edits (append-only) ─────────────────────────────────────────────

export async function insertSessionEdit(edit: NewSessionEdit): Promise<SessionEdit> {
  db.prepare(`
    INSERT INTO session_edits (id, session_id, operation, before_state, after_state, triggered_by, note)
    VALUES (@id, @session_id, @operation, @before_state, @after_state, @triggered_by, @note)
  `).run({
    ...edit,
    before_state: toJson(edit.before_state),
    after_state: toJson(edit.after_state),
  });

  const row = db.prepare('SELECT * FROM session_edits WHERE id = ?').get(edit.id) as Record<string, unknown>;
  return mapEdit(row);
}

export async function getSessionEdits(sessionId: string): Promise<SessionEdit[]> {
  const rows = db.prepare('SELECT * FROM session_edits WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Record<string, unknown>[];
  return rows.map(mapEdit);
}
