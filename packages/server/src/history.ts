/**
 * Undo/redo for the IDE.
 *
 * The IDE holds no derived state — every mutation is a command to the server —
 * so history belongs on this side too. If it lived in the browser it would have
 * to model what each command did to the project in order to reverse it, and
 * that model would drift from the handlers the first time one changed.
 *
 * Instead this snapshots the whole project before a mutating command runs. A
 * project is small (a few hundred kB of plain data at the top end) and the
 * snapshot is a `structuredClone`, so undo is exact by construction rather than
 * by a per-command inverse that has to be written and kept correct.
 *
 * Commands are undoable **by default**. A new mutating command added later is
 * therefore covered without anyone remembering to opt in — the failure mode of
 * the opposite convention is a silently unundoable edit, which is worse than a
 * redundant snapshot.
 */

import type { Project } from '#core/model/project.ts';

/** Snapshots kept per session. Beyond this the oldest is dropped. */
const LIMIT = 100;

/**
 * Two *continuous* edits of the same kind, closer together than this, become
 * one undo step. Typing in a property field fires one command per keystroke;
 * without merging, undo would walk a rename back one letter at a time.
 */
const COALESCE_MS = 600;

/**
 * Only these merge. Everything else is a discrete action the user took
 * deliberately — adding two nodes quickly is two additions, and a fast user
 * must not silently lose a step because they beat a timer.
 */
const COALESCING = new Set([
  'graph.setProps',
  'graph.setPortDefault',
  'graph.moveNodes',
  'project.settings',
  'file.setUi',
]);

export interface Snapshot {
  project: Project;
  /** Human-readable, shown as "Undo add node". */
  label: string;
  /** The command that was about to run, for coalescing. */
  command: string;
  at: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

/**
 * Commands that never change the project, and so never take a snapshot.
 *
 * Read-only queries, actions whose effects land outside the project file
 * (build, run, test), and history itself. `graph.viewport` is here on purpose:
 * panning the canvas is not an edit, and treating it as one would fill the
 * stack with entries that appear to do nothing when undone.
 */
const NON_MUTATING = new Set([
  'hello',
  'project.state',
  'project.open',
  'project.create',
  'project.save',
  'validate.all',
  'graph.viewport',
  'code.generate',
  'code.build',
  'code.run',
  'code.test',
  'libs.search',
  'libs.installPlan',
  'libs.inspect',
  'doctor',
  'edit.undo',
  'edit.redo',
  'edit.history',
]);

/** Labels for the undo entry, so the menu can read "Undo delete nodes". */
const LABELS: Record<string, string> = {
  'project.settings': 'change project settings',
  'project.architecture': 'the layout conversion',
  'graph.addNode': 'add node',
  'graph.moveNodes': 'move nodes',
  'graph.setProps': 'edit properties',
  'graph.setPortDefault': 'change a port default',
  'graph.addVariadic': 'add an input slot',
  'graph.deleteNodes': 'delete nodes',
  'graph.connect': 'connect',
  'graph.disconnect': 'disconnect',
  'graph.addVariable': 'add variable',
  'graph.removeVariable': 'remove variable',
  'file.create': 'create file',
  'file.rename': 'rename file',
  'file.delete': 'delete file',
  'file.setUi': 'edit the UI tree',
  'module.create': 'create module',
  'libs.add': 'add a library',
  'libs.remove': 'remove a library',
};

export function isMutating(command: string): boolean {
  return !NON_MUTATING.has(command);
}

export function labelFor(command: string): string {
  return LABELS[command] ?? command;
}

export class History {
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];

  /**
   * Records the state before `command` runs.
   *
   * Called from the dispatcher rather than from each handler: a handler that
   * forgets is an edit that cannot be undone, and that is not the kind of bug
   * that shows up in testing.
   */
  record(project: Project, command: string): void {
    if (!isMutating(command)) return;

    const previous = this.#undo[this.#undo.length - 1];
    const now = Date.now();
    // Same continuous command, in quick succession: the earlier snapshot
    // already holds the state the user means to return to, so keep it.
    if (
      COALESCING.has(command) &&
      previous &&
      previous.command === command &&
      now - previous.at < COALESCE_MS
    ) {
      previous.at = now;
      this.#redo = [];
      return;
    }

    this.#undo.push({
      project: structuredClone(project),
      label: labelFor(command),
      command,
      at: now,
    });
    if (this.#undo.length > LIMIT) this.#undo.shift();
    // Any new edit invalidates the redo branch: there is no meaningful tree
    // here, and offering a redo that belongs to an abandoned line is worse than
    // offering none.
    this.#redo = [];
  }

  /**
   * Steps back one edit. `current` is the live project, which becomes the redo
   * entry. Returns the project to restore, or undefined when there is nothing.
   */
  undo(current: Project): Project | undefined {
    const entry = this.#undo.pop();
    if (!entry) return undefined;
    this.#redo.push({
      project: structuredClone(current),
      label: entry.label,
      command: entry.command,
      at: Date.now(),
    });
    return entry.project;
  }

  redo(current: Project): Project | undefined {
    const entry = this.#redo.pop();
    if (!entry) return undefined;
    this.#undo.push({
      project: structuredClone(current),
      label: entry.label,
      command: entry.command,
      at: Date.now(),
    });
    return entry.project;
  }

  /** Dropped when a different project is opened; the stacks would not apply. */
  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }

  state(): HistoryState {
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoLabel: this.#undo[this.#undo.length - 1]?.label,
      redoLabel: this.#redo[this.#redo.length - 1]?.label,
    };
  }

  get depth(): number {
    return this.#undo.length;
  }
}
