import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './server';
import { log, logError } from './logger';

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started on stdio transport');
}

main().catch((err) => {
  logError('Fatal startup error', err);
  process.exit(1);
});
