import express from 'express';
import { syncRecentActivities } from '../tools/sync';
import { log, logError } from '../logger';

const VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? 'strava-mcp-verify';

export function startWebhookServer(port = Number(process.env.PORT ?? 3000)): void {
  const app = express();
  app.use(express.json());

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

  app.listen(port, () => {
    log(`Webhook server listening on port ${port}`);
    log(`Strava callback URL: http://<your-host>:${port}/webhook`);
  });
}
