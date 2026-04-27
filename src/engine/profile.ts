import crypto from 'crypto';
import { getActivities, insertSnapshot, getAthleteById } from '../db/queries';
import {
  estimateThresholdHr,
  computeCtlAtl,
  computeSportSplit,
  computeWeeklyVolume,
} from './metrics';
import type { AthleteSnapshot } from '../db/schema';

// Reads all stored activities for an athlete, computes metrics, and writes a snapshot.
// Call this after every sync to keep CTL/ATL/TSB current.
export async function buildAndSaveSnapshot(athleteId: string): Promise<AthleteSnapshot> {
  const athlete = await getAthleteById(athleteId);
  if (!athlete) throw new Error(`Athlete ${athleteId} not found`);

  // Fetch all activities — we need the full history for accurate CTL
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const activities = await getActivities(athleteId, oneYearAgo.toISOString().split('T')[0]);

  const thresholdHr = estimateThresholdHr(activities);
  const { ctl, atl, tsb } = computeCtlAtl(activities, thresholdHr);
  const sportSplit = computeSportSplit(activities);
  const weekly = computeWeeklyVolume(activities);

  const snapshot = await insertSnapshot({
    id: crypto.randomUUID(),
    athlete_id: athleteId,
    snapshot_date: new Date().toISOString().split('T')[0],
    weekly_distance_m: Math.round(weekly.distance_m),
    weekly_elevation_m: Math.round(weekly.elevation_m),
    weekly_duration_s: Math.round(weekly.duration_s),
    ctl,
    atl,
    tsb,
    sport_split: sportSplit,
    notes: null,
  });

  return snapshot;
}
