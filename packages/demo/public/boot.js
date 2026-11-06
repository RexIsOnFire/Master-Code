/**
 * Starts the browser demo.
 *
 * Loads the disk from IndexedDB, builds the command host, and only then starts
 * the IDE - the same app.js the desktop serves. The one thing the IDE sees
 * differently is `globalThis.masterCodeHost`.
 */

import process from './node/process.js';
import { disk } from './vfs.js';

// The core's path code reads the working directory from here, as it would under Node.
globalThis.process = process;

function fatal(error) {
  const panel = document.createElement('div');
  panel.className = 'demo-fatal';
  panel.innerHTML = '<h1>The demo could not start</h1><p></p><p>Reloading usually helps; if not, this browser may be blocking storage or workers for this site.</p>';
  panel.querySelector('p').textContent = String(error?.message ?? error);
  document.body.append(panel);
  console.error(error);
}

function notice(text) {
  const bar = document.createElement('div');
  bar.className = 'demo-notice';
  bar.textContent = text;
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Dismiss';
  close.onclick = () => bar.remove();
  bar.append(close);
  document.body.append(bar);
}

try {
  const loaded = await disk.load();
  if (!loaded.persisted) {
    notice('This browser is not storing data for this site (a private window, or storage is blocked), so projects last only until the tab closes. Use File → Download project to keep one.');
  }
  const { createHost } = await import('./host.js');
  globalThis.masterCodeHost = await createHost();
  await import('./app.js');
} catch (error) {
  fatal(error);
}

// Pending writes are flushed after every command; these catch anything still in flight.
addEventListener('pagehide', () => void disk.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void disk.flush();
});
