import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Settings } from '../core/config.js';
import { log } from '../core/logging.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './create-server.js';

/** stdout carries only MCP JSON-RPC. Everything else goes to stderr. */
export function runStdio(settings: Settings) {
  const reg = undefined;
  serveStdio(() => createServer(settings, reg));
  log('info', `${SERVER_NAME} ${SERVER_VERSION} listening on stdio (mode=${settings.mode}${settings.demo ? ', DEMO' : ''})`);
}
