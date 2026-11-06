/** `node:os` for the page: the demo machine described in `process.js`. */

import { HOME } from './process.js';

export const EOL = '\n';
export const homedir = () => HOME;
export const tmpdir = () => '/tmp';
export const platform = () => 'linux';
export const type = () => 'Linux';
export const arch = () => 'wasm32';
export const hostname = () => 'browser';
export const cpus = () => Array.from({ length: navigator.hardwareConcurrency || 1 }, () => ({ model: 'browser', speed: 0 }));
export const userInfo = () => ({ username: 'demo', homedir: HOME, shell: null, uid: 1000, gid: 1000 });

export default { EOL, homedir, tmpdir, platform, type, arch, hostname, cpus, userInfo };
