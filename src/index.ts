import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './server';
import { startWebhookServer } from './strava/webhook';
import { runMigrations } from './db/schema';
import { log, logError } from './logger';

async function main() {
  // Create SQLite tables if they don't exist yet
  runMigrations();

  // Start webhook server for real-time Strava sync
  // Runs on port 3000 (or PORT env var) alongside the MCP stdio transport
  startWebhookServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started on stdio transport');
}

main().catch((err) => {
  logError('Fatal startup error', err);
  process.exit(1);
});
