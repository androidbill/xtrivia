#!/usr/bin/env node
// Single source of truth for the app version is public/version.json — this script keeps
// public/version.js and the cache name in public/sw.js in lockstep with it, since a
// browser only re-installs a service worker when sw.js's own bytes change.
//
// Usage: npm run version:bump [YYYY.MM.DD.NN]
// With no argument, bumps to today's date, incrementing the sequence number if today's
// date already matches the current version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const VERSION_JSON = join(PUBLIC, 'version.json');
const VERSION_JS = join(PUBLIC, 'version.js');
const SW_JS = join(PUBLIC, 'sw.js');

const pad = (n) => String(n).padStart(2, '0');

function todayPrefix() {
  const d = new Date();
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function nextVersion(explicit) {
  if (explicit) return explicit;
  const { version: current } = JSON.parse(readFileSync(VERSION_JSON, 'utf8'));
  const prefix = todayPrefix();
  const lastDot = current.lastIndexOf('.');
  const currentPrefix = current.slice(0, lastDot);
  const currentSeq = Number(current.slice(lastDot + 1));
  const seq = currentPrefix === prefix ? currentSeq + 1 : 1;
  return `${prefix}.${pad(seq)}`;
}

const version = nextVersion(process.argv[2]);

writeFileSync(VERSION_JSON, `${JSON.stringify({ version }, null, 2)}\n`);

writeFileSync(
  VERSION_JS,
  readFileSync(VERSION_JS, 'utf8').replace(/export const VERSION = '[^']*';/, `export const VERSION = '${version}';`),
);

writeFileSync(
  SW_JS,
  readFileSync(SW_JS, 'utf8').replace(/const CACHE = 'xtrivia-shell-[^']*';/, `const CACHE = 'xtrivia-shell-${version}';`),
);

console.log(`Bumped xTrivia to version ${version}`);
