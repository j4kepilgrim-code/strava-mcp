import type { Activity } from '../db/schema';

const CTL_DAYS = 42;
const ATL_DAYS = 7;
const DEFAULT_THRESHOLD_HR = 165;
const SPORT_SPLIT_DAYS = 28;

export function calculateTss(durationS: number, avgHr: number, thresholdHr: number): number {
  const hrRatio = avgHr / thresholdHr;
  return (durationS * hrRatio * hrRatio) / 3600 * 100;
}

// Estimates threshold HR as 88% of the 95th-percentile max HR across all activities.
// Falls back to DEFAULT_THRESHOLD_HR if no HR data exists.
export function estimateThresholdHr(activities: Activity[]): number {
  const maxHrs = activities
    .map((a) => a.max_hr)
    .filter((hr): hr is number => hr !== null && hr > 100)
    .sort((a, b) => a - b);

  if (maxHrs.length === 0) return DEFAULT_THRESHOLD_HR;

  const p95Index = Math.floor(maxHrs.length * 0.95);
  const maxHr = maxHrs[Math.min(p95Index, maxHrs.length - 1)];
  return Math.round(maxHr * 0.88);
}

export interface CtlAtlResult {
  ctl: number;
  atl: number;
  tsb: number;
}

// Computes CTL/ATL/TSB by iterating every calendar day from first activity to today.
// Days with no activity contribute TSS = 0, causing both values to decay naturally.
export function computeCtlAtl(activities: Activity[], thresholdHr: number): CtlAtlResult {
  // Aggregate TSS per calendar day
  const dailyTss = new Map<string, number>();
  for (const a of activities) {
    if (!a.moving_time_s || !a.avg_hr) continue;
    const tss = calculateTss(a.moving_time_s, a.avg_hr, thresholdHr);
    dailyTss.set(a.activity_date, (dailyTss.get(a.activity_date) ?? 0) + tss);
  }

  const sortedDates = [...dailyTss.keys()].sort();
  if (sortedDates.length === 0) return { ctl: 0, atl: 0, tsb: 0 };

  let ctl = 0;
  let atl = 0;

  const start = new Date(sortedDates[0]);
  const end = new Date();
  end.setHours(0, 0, 0, 0);

  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const tss = dailyTss.get(dateStr) ?? 0;
    ctl = ctl * (1 - 1 / CTL_DAYS) + tss * (1 / CTL_DAYS);
    atl = atl * (1 - 1 / ATL_DAYS) + tss * (1 / ATL_DAYS);
  }

  return {
    ctl: Math.round(ctl * 10) / 10,
    atl: Math.round(atl * 10) / 10,
    tsb: Math.round((ctl - atl) * 10) / 10,
  };
}

export interface SportSplit {
  run_pct: number;
  bike_pct: number;
  swim_pct: number;
}

// Computes sport split as % of total moving time over the last SPORT_SPLIT_DAYS days.
export function computeSportSplit(activities: Activity[]): SportSplit {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SPORT_SPLIT_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = activities.filter((a) => a.activity_date >= cutoffStr && a.moving_time_s);

  const totals = { run: 0, bike: 0, swim: 0 };
  let total = 0;

  for (const a of recent) {
    const t = a.moving_time_s ?? 0;
    if (a.sport_type === 'Run') totals.run += t;
    else if (a.sport_type === 'Ride') totals.bike += t;
    else if (a.sport_type === 'Swim') totals.swim += t;
    total += t;
  }

  if (total === 0) return { run_pct: 0, bike_pct: 0, swim_pct: 0 };

  return {
    run_pct: Math.round((totals.run / total) * 100),
    bike_pct: Math.round((totals.bike / total) * 100),
    swim_pct: Math.round((totals.swim / total) * 100),
  };
}

export interface WeeklyVolume {
  distance_m: number;
  elevation_m: number;
  duration_s: number;
}

export function computeWeeklyVolume(activities: Activity[]): WeeklyVolume {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = activities.filter((a) => a.activity_date >= cutoffStr);

  return recent.reduce(
    (acc, a) => ({
      distance_m: acc.distance_m + (a.distance_m ?? 0),
      elevation_m: acc.elevation_m + (a.elevation_gain_m ?? 0),
      duration_s: acc.duration_s + (a.moving_time_s ?? 0),
    }),
    { distance_m: 0, elevation_m: 0, duration_s: 0 }
  );
}
