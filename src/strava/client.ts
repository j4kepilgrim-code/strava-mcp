import axios, { AxiosError } from 'axios';
import { getValidAccessToken } from './auth';
import type { StravaAthlete, StravaActivity, StravaDetailedActivity } from './types';

const BASE_URL = 'https://www.strava.com/api/v3';
const PER_PAGE = 200;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getValidAccessToken();
  return { Authorization: `Bearer ${token}` };
}

function handleStravaError(err: unknown): never {
  if (err instanceof AxiosError && err.response?.status === 429) {
    const resetAt = err.response.headers['x-ratelimit-reset'];
    const minutesUntilReset = resetAt
      ? Math.ceil((Number(resetAt) * 1000 - Date.now()) / 60000)
      : 15;
    throw new Error(`Strava rate limit reached — try again in ${minutesUntilReset} minutes`);
  }
  throw err;
}

export async function getAthlete(): Promise<StravaAthlete> {
  try {
    const { data } = await axios.get<StravaAthlete>(`${BASE_URL}/athlete`, {
      headers: await authHeaders(),
    });
    return data;
  } catch (err) {
    handleStravaError(err);
  }
}

export async function getActivityDetail(stravaActivityId: string): Promise<StravaDetailedActivity> {
  try {
    const { data } = await axios.get<StravaDetailedActivity>(
      `${BASE_URL}/activities/${stravaActivityId}`,
      { headers: await authHeaders() }
    );
    return data;
  } catch (err) {
    handleStravaError(err);
  }
}

// Fetches all activities after a Unix timestamp, handling Strava pagination.
export async function getActivities(afterTimestamp: number): Promise<StravaActivity[]> {
  const headers = await authHeaders();
  const activities: StravaActivity[] = [];
  let page = 1;

  try {
    while (true) {
      const { data } = await axios.get<StravaActivity[]>(`${BASE_URL}/athlete/activities`, {
        headers,
        params: { after: afterTimestamp, per_page: PER_PAGE, page },
      });

      if (data.length === 0) break;
      activities.push(...data);
      if (data.length < PER_PAGE) break;
      page++;
    }
  } catch (err) {
    handleStravaError(err);
  }

  return activities;
}
