#!/usr/bin/env node
/**
 * One command to bring the whole demo up: seed the database, then run the API,
 * the web app and the admin console together with prefixed output.
 *
 * Everything runs against the embedded PostgreSQL, so there is nothing to
 * install and no credentials to configure. WhatsApp and SMS fall back to the
 * demo transport, which records the messages it would have sent — visible at
 * /demo in the web app.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const COLORS = { api: '[36m', web: '[35m', admin: '[33m', reset: '[0m' };

/** The address a phone on the same Wi-Fi should use. */
function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        return entry.address;
      }
    }
  }
  return 'localhost';
}

function run(name, args, extraEnv = {}) {
  const child = spawn(npm, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
  });

  const prefix = `${COLORS[name] ?? ''}[${name}]${COLORS.reset}`;
  const forward = (stream, sink) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) sink.write(`${prefix} ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  return child;
}

async function main() {
  const host = lanAddress();

  console.log('\nSeeding demo data…\n');
  const seed = run('api', ['run', 'seed']);
  const [seedCode] = await once(seed, 'exit');
  if (seedCode !== 0) {
    console.error('\nSeeding failed. Try `npm install` first.\n');
    process.exit(1);
  }

  const children = [
    run('api', ['run', 'dev'], { WEB_URL: `http://${host}:5174` }),
    run('web', ['run', 'dev:web']),
    run('admin', ['run', 'dev:admin']),
  ];

  const banner = [
    '',
    '  ParkPing demo is up.',
    '',
    `    Reporter & owner app   http://localhost:5174`,
    `    Demo console           http://localhost:5174/demo`,
    `    Admin console          http://localhost:5173`,
    `    API                    http://localhost:4000`,
    '',
    `    On your phone (same Wi-Fi)   http://${host}:5174`,
    `    Scan a sticker               http://${host}:5174/s/NORDPARK01`,
    '',
    '  Sign in as admin@parkping.test or anna@nordpark.test —',
    '  the six-digit code is shown on screen in demo mode.',
    '',
  ].join('\n');

  setTimeout(() => console.log(banner), 3500);

  const shutdown = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
