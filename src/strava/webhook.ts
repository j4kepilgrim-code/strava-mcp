import express from 'express';
import { exchangeToken } from './auth';
import { syncRecentActivities } from '../tools/sync';
import { log, logError } from '../logger';

const VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? 'strava-mcp-verify';

export function startWebhookServer(port = Number(process.env.PORT ?? 3000)): void {
  const app = express();
  app.use(express.json());

  // ── OAuth callback ──────────────────────────────────────────────────────────
  // Strava redirects here after the athlete approves access.
  // Exchanges the code automatically — no copy/paste needed.
  app.get('/auth/callback', async (req, res) => {
    const code = req.query['code'] as string | undefined;
    const error = req.query['error'] as string | undefined;

    if (error) {
      log(`OAuth denied: ${error}`);
      res.send(html('Connection cancelled', `<p>You cancelled the Strava connection. You can close this tab.</p>`, false));
      return;
    }

    if (!code) {
      res.send(html('Missing code', `<p>No authorisation code received from Strava.</p>`, false));
      return;
    }

    try {
      const tokens = await exchangeToken(code);
      log(`OAuth complete — athlete ID: ${tokens.athlete_id}`);
      res.send(html(
        'Connected to Strava!',
        `<p>Your Strava account is connected. You can close this tab and return to Claude.</p>
         <p style="color:#666;font-size:14px">Athlete ID: ${tokens.athlete_id}</p>`,
        true
      ));
    } catch (err) {
      logError('OAuth token exchange failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      res.send(html('Connection failed', `<p>Could not connect to Strava: ${msg}</p>`, false));
    }
  });

  // ── Strava webhook verification (GET) ───────────────────────────────────────
  // Strava sends this when you register the webhook subscription.
  // Must respond with hub.challenge to confirm ownership.
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      log('Strava webhook verification successful');
      res.json({ 'hub.challenge': challenge });
    } else {
      log(`Webhook verification failed — token mismatch (received: ${token})`);
      res.sendStatus(403);
    }
  });

  // ── Strava activity event (POST) ────────────────────────────────────────────
  // Strava sends this when a new activity is created, updated, or deleted.
  app.post('/webhook', (req, res) => {
    // Respond immediately — Strava expects 200 within 2 seconds
    res.sendStatus(200);

    const event = req.body as {
      object_type: string;
      aspect_type: string;
      owner_id: number;
      object_id: number;
    };

    log(`Strava webhook event: ${event.object_type} ${event.aspect_type} (owner: ${event.owner_id})`);

    // Only sync on new activity creates — ignore updates and deletes
    if (event.object_type === 'activity' && event.aspect_type === 'create') {
      syncRecentActivities()
        .then((result) => log(`Auto-sync complete: ${result.message}`))
        .catch((err) => logError('Auto-sync failed after webhook event', err));
    }
  });

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'strava-mcp-webhook' });
  });

  const httpServer = app.listen(port, () => {
    log(`Webhook server listening on port ${port}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} already in use — OAuth callback and webhook unavailable. If auth is needed, restart Claude Desktop to free the port.`);
    } else {
      logError('Webhook server error', err);
    }
  });
}

function html(title: string, body: string, success: boolean): string {
  const colour = success ? '#fc4c02' : '#cc0000';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; }
    h1 { color: ${colour}; }
    p { color: #333; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}
