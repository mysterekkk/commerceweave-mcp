import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
const f = new URL('../dist/index.js', import.meta.url);
let s = readFileSync(f, 'utf8');
if (!s.startsWith('#!')) s = '#!/usr/bin/env node\n' + s;
writeFileSync(f, s);
try { chmodSync(f, 0o755); } catch {}
