import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Integration tests run the real compiled CLI, so make sure dist/ is current. No shell involved. */
export default function setup() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const args of [[tsc, '-p', 'tsconfig.build.json'], ['scripts/postbuild.mjs']]) {
    const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`build step failed: ${args.join(' ')}`);
  }
}
