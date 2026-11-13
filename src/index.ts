import { HELP, cmdApprove, cmdCheck, cmdDoctor, cmdListConnections, cmdProposals, cmdSetupAllegro, cmdTest } from './cli/commands.js';
import { loadSettings } from './core/config.js';
import { toCommerceError } from './core/errors.js';
import { log, setLogLevel } from './core/logging.js';
import { runStdio } from './server/stdio.js';
import { SERVER_VERSION } from './server/create-server.js';

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') { process.stdout.write(SERVER_VERSION + '\n'); return 0; }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP + '\n'); return 0; }
  if (!cmd && process.stdin.isTTY) { process.stdout.write(HELP + '\n'); return 0; }

  const settings = loadSettings();
  setLogLevel(settings.logLevel);
  switch (cmd) {
    case undefined:
    case 'serve':
      runStdio(settings);
      return -1; // keep running
    case 'check': return cmdCheck(settings);
    case 'doctor': return cmdDoctor(settings);
    case 'list-connections': return cmdListConnections(settings);
    case 'test-connection': return cmdTest(settings, rest[0]);
    case 'setup': return rest[0] === 'allegro' ? cmdSetupAllegro(settings, rest[1]) : (process.stdout.write('usage: setup allegro [connectionId]\n'), 2);
    case 'approve': return cmdApprove(settings, rest[0]);
    case 'proposals': return cmdProposals(settings);
    default: process.stdout.write(`Unknown command "${cmd}"\n\n${HELP}\n`); return 2;
  }
}

main().then(
  (code) => { if (code >= 0) process.exit(code); },
  (e) => { log('error', toCommerceError(e).message); process.exit(1); },
);
