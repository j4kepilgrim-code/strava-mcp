import { db } from './client';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS athlete (
  id TEXT PRIMARY KEY,
  name TEXT,
  strava_id TEXT UNIQUE,
  weight_kg REAL,
  ftp_watts INTEGER,
  threshold_pace TEXT,
  css_per_100m TEXT,
  vo2max_estimate REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  strava_id TEXT UNIQUE,
  athlete_id TEXT REFERENCES athlete(id),
  sport_type TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  distance_m REAL,
  moving_time_s INTEGER,
  elapsed_time_s INTEGER,
  elevation_gain_m REAL,
  avg_hr INTEGER,
  max_hr INTEGER,
  suffer_score INTEGER,
  perceived_effort INTEGER,
  sport_data TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS athlete_snapshots (
  id TEXT PRIMARY KEY,
  athlete_id TEXT REFERENCES athlete(id),
  snapshot_date TEXT NOT NULL,
  weekly_distance_m REAL,
  weekly_elevation_m REAL,
  weekly_duration_s INTEGER,
  ctl REAL,
  atl REAL,
  tsb REAL,
  sport_split TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  athlete_id TEXT REFERENCES athlete(id),
  goal_type TEXT NOT NULL,
  goal_date TEXT NOT NULL,
  goal_description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  constraints TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_sessions (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES plans(id),
  scheduled_date TEXT NOT NULL,
  original_date TEXT NOT NULL,
  week_number INTEGER NOT NULL,
  session_type TEXT NOT NULL,
  sport TEXT NOT NULL,
  targets TEXT,
  rationale TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'planned',
  strava_activity_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coaching_notes (
  id TEXT PRIMARY KEY,
  athlete_id TEXT REFERENCES athlete(id),
  note_date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_edits (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES plan_sessions(id),
  operation TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  triggered_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export function runMigrations(): void {
  db.exec(SCHEMA_SQL);
}

// TypeScript types matching each table row

export interface Athlete {
  id: string;
  name: string | null;
  strava_id: string | null;
  weight_kg: number | null;
  ftp_watts: number | null;
  threshold_pace: string | null;
  css_per_100m: string | null;
  vo2max_estimate: number | null;
  updated_at: string;
}

export interface Activity {
  id: string;
  strava_id: string | null;
  athlete_id: string;
  sport_type: 'Run' | 'Ride' | 'Swim' | 'WeightTraining';
  activity_date: string;
  distance_m: number | null;
  moving_time_s: number | null;
  elapsed_time_s: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  suffer_score: number | null;
  perceived_effort: number | null;
  sport_data: RunData | RideData | SwimData | null;
  synced_at: string;
}

export interface LapData {
  lap_index: number;
  distance_m: number;
  moving_time_s: number;
  avg_pace_per_km?: string;  // runs
  avg_speed_kph?: number;    // rides
  avg_hr?: number;
  max_hr?: number;
  avg_cadence?: number;
  avg_watts?: number;
}

export interface RunData {
  avg_pace_per_km: string | null;
  avg_cadence: number | null;
  avg_power: number | null;
  laps?: LapData[];
}

export interface RideData {
  avg_power_w: number | null;
  np_w: number | null;
  ftp_percentage: number | null;
  avg_cadence: number | null;
  avg_speed_kph: number | null;
  laps?: LapData[];
}

export interface SwimData {
  avg_pace_per_100m: string | null;
  pool_length_m: number | null;
  avg_stroke_rate: number | null;
}

export interface AthleteSnapshot {
  id: string;
  athlete_id: string;
  snapshot_date: string;
  weekly_distance_m: number | null;
  weekly_elevation_m: number | null;
  weekly_duration_s: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  sport_split: { run_pct: number; bike_pct: number; swim_pct: number } | null;
  notes: string | null;
  created_at: string;
}

export interface Plan {
  id: string;
  athlete_id: string;
  goal_type: '5k' | '10k' | 'half_marathon' | 'marathon' | 'hyrox' | 'olympic_tri' | 'sprint_tri' | 'cycling_race' | 'general_fitness';
  goal_date: string;
  goal_description: string | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  constraints: PlanConstraints | null;
  created_at: string;
}

export interface PlanConstraints {
  available_days: number;
  max_hours_per_week: number;
  preferred_session_types: string[];
  excluded_days: number[];
}

export interface PlanSession {
  id: string;
  plan_id: string;
  scheduled_date: string;
  original_date: string;
  week_number: number;
  session_type:
    | 'easy_run' | 'threshold' | 'long_run' | 'tempo' | 'intervals'
    | 'brick' | 'long_ride' | 'open_water' | 'recovery' | 'strength' | 'race';
  sport: 'run' | 'bike' | 'swim' | 'strength';
  targets: SessionTargets | null;
  rationale: string;
  priority: 'key' | 'standard' | 'optional';
  status: 'planned' | 'completed' | 'skipped' | 'moved';
  strava_activity_id: string | null;
  created_at: string;
}

export interface SessionTargets {
  distance_m?: number;
  duration_s?: number;
  pace_zone?: string;
  power_zone?: string;
  hr_zone?: string;
  description?: string;
  // Structured session detail (intervals + threshold)
  reps?: number;
  rep_distance_m?: number;   // for distance-based reps (intervals)
  rep_duration_s?: number;   // for time-based reps (threshold blocks)
  rep_pace?: string;         // single target pace e.g. "4:15/km"
  recovery_s?: number;
  recovery_type?: 'jog' | 'walk';
  warmup_s?: number;
  cooldown_s?: number;
}

export interface CoachingNote {
  id: string;
  athlete_id: string;
  note_date: string;
  content: string;
  created_at: string;
}

export interface SessionEdit {
  id: string;
  session_id: string;
  operation: 'swap' | 'move' | 'skip' | 'replace' | 'rescale' | 'complete';
  before_state: Partial<PlanSession> | null;
  after_state: Partial<PlanSession> | null;
  triggered_by: 'user' | 'llm_rescheduler' | 'strava_sync' | 'engine';
  note: string | null;
  created_at: string;
}

// Insert types — omit server-generated fields
export type NewCoachingNote = Omit<CoachingNote, 'created_at'>;
export type NewAthlete = Omit<Athlete, 'updated_at'>;
export type NewActivity = Omit<Activity, 'synced_at'>;
export type NewAthleteSnapshot = Omit<AthleteSnapshot, 'created_at'>;
export type NewPlan = Omit<Plan, 'created_at'>;
export type NewPlanSession = Omit<PlanSession, 'created_at'>;
export type NewSessionEdit = Omit<SessionEdit, 'created_at'>;
