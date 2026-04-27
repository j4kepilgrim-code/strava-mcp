// All output goes to stderr. stdout is reserved for the MCP protocol wire in stdio mode.
// Never use console.log() anywhere in this codebase.

export function log(msg: string): void {
  process.stderr.write(`[strava-mcp] ${msg}\n`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : '';
  process.stderr.write(`[strava-mcp] ERROR ${msg}${detail}\n`);
}
