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
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, networkInterfaces, tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const COLORS = { api: '[36m', web: '[35m', admin: '[33m', reset: '[0m' };

/**
 * The address a phone on the same Wi-Fi should use.
 *
 * Walking `networkInterfaces()` and taking the first non-internal address picks
 * whichever virtual adapter VirtualBox or Hyper-V happens to have installed,
 * which sends you to a dead address on your phone. Opening a UDP socket toward
 * a public address makes the OS resolve its own default route and tells us the
 * interface traffic actually leaves by. No packet is sent.
 */
async function lanAddress() {
  // `connect` is asynchronous — reading address() before it settles returns an
  // unbound socket, which is how this quietly fell back to localhost.
  const viaRoute = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const socket = createSocket('udp4');
      socket.once('error', () => {
        socket.close();
        finish(null);
      });
      socket.connect(53, '8.8.8.8', () => {
        const address = socket.address().address;
        socket.close();
        finish(address && address !== '0.0.0.0' ? address : null);
      });
      setTimeout(() => finish(null), 1500).unref();
    } catch {
      finish(null);
    }
  });
  if (viaRoute) return viaRoute;

  // No route (offline, or a locked-down network). Fall back to naming rules,
  // skipping the adapters VirtualBox, VMware, Hyper-V and WSL install.
  const virtual = /virtual|vmware|hyper-v|vethernet|loopback|docker|wsl/i;
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        return entry.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Keep the embedded database off OneDrive. A synced folder corrupts a
 * PostgreSQL data directory mid-write, and the failure looks like an
 * unexplained WASM crash rather than anything to do with syncing.
 */
function databasePath() {
  const base = isWindows
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base || tmpdir(), 'ParkPing', 'pgdata');
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
  const host = await lanAddress();
  const env = { EMBEDDED_DB_PATH: databasePath(), WEB_URL: `http://${host}:5174` };

  console.log('\nSeeding demo data…\n');
  const seed = run('api', ['run', 'seed'], env);
  const [seedCode] = await once(seed, 'exit');
  if (seedCode !== 0) {
    console.error('\nSeeding failed. Try `npm ci` first.\n');
    process.exit(1);
  }

  /*
   * The compiled server rather than `tsx watch`. The demo should be the most
   * reliable thing in the repository, and npm's optional-dependency resolution
   * drops esbuild's platform binary often enough that a demo depending on it
   * fails in front of exactly the people you wanted to show it to. `npm run
   * dev` is still there for development.
   */
  const children = [
    run('api', ['run', 'start', '-w', '@parkping/api'], env),
    run('web', ['run', 'dev:web']),
    run('admin', ['run', 'dev:admin']),
  ];

  const banner = [
    '',
    '  ParkPing demo is up.',
    '',
    '    Reporter & owner app   http://localhost:5174',
    '    Demo console           http://localhost:5174/demo',
    '    Admin console          http://localhost:5173',
    '    API                    http://localhost:4000',
    '',
    `    On your phone (same Wi-Fi)   http://${host}:5174`,
    `    Scan a sticker               http://${host}:5174/s/PARKPNG001`,
    `    An unclaimed one             http://${host}:5174/s/PARKPNG004`,
    '',
    '  Sign in as admin@parkping.test or anna@nordpark.test —',
    '  the six-digit code is shown on screen in demo mode.',
    '',
  ].join('\n');

  setTimeout(() => console.log(banner), 4000);

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
