// Strava API response shapes

export interface StravaTokenResponse {
  token_type: string;
  expires_at: number;       // Unix timestamp
  expires_in: number;       // seconds until expiry
  refresh_token: string;
  access_token: string;
  athlete: StravaAthlete;
}

export interface StravaAthlete {
  id: number;
  firstname: string;
  lastname: string;
  weight: number;           // kg
  ftp: number | null;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;             // Run | Ride | Swim | WeightTraining | ...
  sport_type: string;
  start_date: string;       // ISO 8601
  distance: number;         // metres
  moving_time: number;      // seconds
  elapsed_time: number;     // seconds
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  perceived_exertion?: number;
  average_cadence?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  average_speed: number;    // m/s
  kilojoules?: number;
  map?: { summary_polyline: string };
  // Run-specific
  average_pace?: number;
  // Swim-specific
  pool_length?: number;
  average_stroke_rate?: number;
}

export interface StravaLap {
  id: number;
  name: string;
  lap_index: number;
  distance: number;        // metres
  moving_time: number;     // seconds
  elapsed_time: number;    // seconds
  average_speed: number;   // m/s
  max_speed: number;       // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_watts?: number;
}

export interface StravaDetailedActivity extends StravaActivity {
  laps?: StravaLap[];
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;       // Unix timestamp
  athlete_id: number;
}
