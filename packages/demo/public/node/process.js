/**
 * `node:process` for the page.
 *
 * The demo is a POSIX machine with one user, `demo`, whose home directory holds
 * the projects. `platform` is 'linux' so the core takes its POSIX paths - there
 * are no drive letters to offer and no batch files to launch. Nothing here can
 * exit or signal anything: the page has no process to end, and pretending it
 * did would hide a bug in whatever called it.
 */

export const HOME = '/home/demo';

const env = {
  HOME,
  USER: 'demo',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/tmp',
};

const unavailable = (what) => () => {
  throw new Error(`${what} is not available in the browser demo.`);
};

const process = {
  platform: 'linux',
  arch: 'wasm32',
  env,
  argv: ['/usr/bin/node', '/demo'],
  execArgv: [],
  version: 'v0.0.0-browser',
  versions: {},
  pid: 1,
  exitCode: undefined,
  cwd: () => HOME,
  chdir: unavailable('process.chdir'),
  exit: unavailable('process.exit'),
  kill: unavailable('process.kill'),
  on: () => process,
  once: () => process,
  off: () => process,
  emitWarning: () => {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign(
    (previous) => {
      const now = performance.now();
      const seconds = Math.floor(now / 1000);
      const nanos = Math.floor((now % 1000) * 1e6);
      return previous ? [seconds - previous[0], nanos - previous[1]] : [seconds, nanos];
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  stdout: { write: (text) => (console.log(String(text).replace(/\n$/, '')), true), isTTY: false },
  stderr: { write: (text) => (console.warn(String(text).replace(/\n$/, '')), true), isTTY: false },
};

export const { platform, arch, argv, version, versions, cwd, exit, nextTick } = process;
export { env };
export default process;
