import crypto from 'crypto';
import { getAthlete, getActivities } from '../strava/client';
import { loadTokens } from '../strava/auth';
import {
  upsertAthlete,
  getAthleteByStravaId,
  upsertActivities,
  getMostRecentActivityDate,
} from '../db/queries';
import { buildAndSaveSnapshot } from '../engine/profile';
import type { NewActivity, RunData, RideData, SwimData } from '../db/schema';
import type { StravaActivity } from '../strava/types';

const COLD_START_DAYS = 365 * 5;

export async function syncRecentActivities(): Promise<{ synced: number; message: string }> {
  const tokens = loadTokens();
  if (!tokens) {
    return { synced: 0, message: 'Not authenticated — call get_oauth_url to connect Strava first' };
  }

  // Ensure athlete record exists in DB
  const stravaAthlete = await getAthlete();
  let athlete = await getAthleteByStravaId(stravaAthlete.id.toString());

  if (!athlete) {
    athlete = await upsertAthlete({
      id: crypto.randomUUID(),
      name: `${stravaAthlete.firstname} ${stravaAthlete.lastname}`,
      strava_id: stravaAthlete.id.toString(),
      weight_kg: stravaAthlete.weight ?? null,
      ftp_watts: stravaAthlete.ftp ?? null,
      threshold_pace: null,
      css_per_100m: null,
      vo2max_estimate: null,
    });
  }

  // Incremental sync: use most recent synced_at, or fall back to 1 year cold start
  const lastSynced = await getMostRecentActivityDate(athlete.id);
  const afterTimestamp = lastSynced
    ? Math.floor(new Date(lastSynced).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - COLD_START_DAYS * 24 * 60 * 60;

  const stravaActivities = await getActivities(afterTimestamp);
  if (stravaActivities.length === 0) {
    return { synced: 0, message: 'No new activities since last sync' };
  }

  const activities: NewActivity[] = stravaActivities.map((a) =>
    mapActivity(a, athlete!.id)
  );

  await upsertActivities(activities);
  await buildAndSaveSnapshot(athlete.id);

  return {
    synced: activities.length,
    message: lastSynced
      ? `Synced ${activities.length} new activities since last sync`
      : `Cold start: synced ${activities.length} activities from the past 5 years`,
  };
}

function mapActivity(a: StravaActivity, athleteId: string): NewActivity {
  const sportType = normaliseSportType(a.sport_type ?? a.type);

  return {
    id: crypto.randomUUID(),
    strava_id: a.id.toString(),
    athlete_id: athleteId,
    sport_type: sportType,
    activity_date: (a.start_date_local ?? a.start_date).split('T')[0],
    distance_m: a.distance ?? null,
    moving_time_s: a.moving_time ?? null,
    elapsed_time_s: a.elapsed_time ?? null,
    elevation_gain_m: a.total_elevation_gain ?? null,
    avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
    max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    suffer_score: a.suffer_score ?? null,
    perceived_effort: a.perceived_exertion ? Math.round(a.perceived_exertion) : null,
    sport_data: buildSportData(a, sportType),
  };
}

function normaliseSportType(type: string): NewActivity['sport_type'] {
  const map: Record<string, NewActivity['sport_type']> = {
    Run: 'Run',
    TrailRun: 'Run',
    VirtualRun: 'Run',
    Ride: 'Ride',
    VirtualRide: 'Ride',
    EBikeRide: 'Ride',
    GravelRide: 'Ride',
    MountainBikeRide: 'Ride',
    Swim: 'Swim',
    OpenWaterSwim: 'Swim',
    WeightTraining: 'WeightTraining',
    Workout: 'WeightTraining',
  };
  return map[type] ?? 'WeightTraining';
}

function buildSportData(
  a: StravaActivity,
  sportType: NewActivity['sport_type']
): RunData | RideData | SwimData | null {
  if (sportType === 'Run') {
    return {
      avg_pace_per_km: a.average_speed ? formatPace(a.average_speed) : null,
      avg_cadence: a.average_cadence ? Math.round(a.average_cadence) : null,
      avg_power: a.average_watts ? Math.round(a.average_watts) : null,
    } satisfies RunData;
  }

  if (sportType === 'Ride') {
    return {
      avg_power_w: a.average_watts ? Math.round(a.average_watts) : null,
      np_w: a.weighted_average_watts ? Math.round(a.weighted_average_watts) : null,
      ftp_percentage: null, // populated by profile builder once FTP is known
      avg_cadence: a.average_cadence ? Math.round(a.average_cadence) : null,
      avg_speed_kph: a.average_speed ? Math.round(a.average_speed * 3.6 * 10) / 10 : null,
    } satisfies RideData;
  }

  if (sportType === 'Swim') {
    return {
      avg_pace_per_100m: a.average_speed ? formatSwimPace(a.average_speed) : null,
      pool_length_m: a.pool_length ?? null,
      avg_stroke_rate: a.average_stroke_rate ? Math.round(a.average_stroke_rate) : null,
    } satisfies SwimData;
  }

  return null;
}

// Converts m/s to "MM:SS per km" string
function formatPace(speedMs: number): string {
  const secondsPerKm = Math.round(1000 / speedMs);
  const mins = Math.floor(secondsPerKm / 60);
  const secs = secondsPerKm % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Converts m/s to "MM:SS per 100m" string
function formatSwimPace(speedMs: number): string {
  const secondsPer100m = Math.round(100 / speedMs);
  const mins = Math.floor(secondsPer100m / 60);
  const secs = secondsPer100m % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
