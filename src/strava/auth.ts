import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { StravaTokenResponse, StoredTokens } from './types';

dotenv.config();

const TOKENS_PATH = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.strava-mcp', '.strava-tokens.json');
const TOKEN_URL = 'https://www.strava.com/oauth/token';

function getClientId(): string {
  const id = process.env.STRAVA_CLIENT_ID;
  if (!id) throw new Error('STRAVA_CLIENT_ID not set in .env');
  return id;
}

function getClientSecret(): string {
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!secret) throw new Error('STRAVA_CLIENT_SECRET not set in .env');
  return secret;
}

export function getAuthUrl(): string {
  const redirectUri = process.env.STRAVA_REDIRECT_URI ?? 'http://localhost:3000/auth/callback';
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'activity:read_all',
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeToken(code: string): Promise<StoredTokens> {
  const { data } = await axios.post<StravaTokenResponse>(TOKEN_URL, {
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code,
    grant_type: 'authorization_code',
  });

  const tokens: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_id: data.athlete.id,
  };

  saveTokens(tokens);
  return tokens;
}

// Returns a valid access token, refreshing if needed. Call before every Strava API request.
export async function getValidAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('No Strava tokens found — run get_oauth_url and complete OAuth first');

  const expiresInSeconds = tokens.expires_at - Math.floor(Date.now() / 1000);
  if (expiresInSeconds > 60) return tokens.access_token;

  const { data } = await axios.post<StravaTokenResponse>(TOKEN_URL, {
    client_id: getClientId(),
    client_secret: getClientSecret(),
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const refreshed: StoredTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_id: tokens.athlete_id,
  };

  saveTokens(refreshed);
  return refreshed.access_token;
}

export function loadTokens(): StoredTokens | null {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as StoredTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}
