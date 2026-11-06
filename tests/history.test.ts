/**
 * Undo/redo.
 *
 * The stacks are server-side and snapshot-based, so the things worth asserting
 * are the policies rather than the mechanics: what counts as an edit, what gets
 * merged into one step, when the redo branch is discarded, and that a restored
 * snapshot is genuinely detached from the live project.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { must } from './helpers.ts';
import { History, isMutating, labelFor } from '#server/history.ts';
import { createDefaultRegistry } from '#core/nodes/catalog/index.ts';
import { createDefaultTemplates } from '#core/project/templates.ts';
import type { Project } from '#core/model/project.ts';

const nodes = createDefaultRegistry();
const templates = createDefaultTemplates();

function project(): Project {
  const template = must(templates.get('python/cli'), 'the python/cli template');
  return template.build({ registry: nodes, options: { name: 'Demo', language: 'python' } });
}

describe('undo history', () => {
  it('treats reads, builds and viewport changes as non-edits', () => {
    for (const command of [
      'project.state',
      'validate.all',
      'code.build',
      'code.run',
      'doctor',
      'graph.viewport',
      'edit.undo',
    ]) {
      assert.equal(isMutating(command), false, `${command} should not create an undo step`);
    }
  });

  it('treats an unrecognised command as an edit', () => {
    // Undoable by default: a mutating command added later is covered without
    // anyone remembering to opt in.
    assert.equal(isMutating('graph.somethingNew'), true);
    assert.equal(labelFor('graph.somethingNew'), 'graph.somethingNew');
  });

  it('restores the earlier state and reports what it will undo', () => {
    const history = new History();
    const p = project();
    const original = p.name;

    history.record(p, 'project.settings');
    p.name = 'Renamed';

    assert.deepEqual(history.state(), {
      canUndo: true,
      canRedo: false,
      undoLabel: 'change project settings',
      redoLabel: undefined,
    });

    const restored = must(history.undo(p), 'the restored project');
    assert.equal(restored.name, original);
    assert.equal(history.state().canRedo, true);
  });

  it('redoes what it undid', () => {
    const history = new History();
    const p = project();

    history.record(p, 'graph.addNode');
    p.name = 'After';

    const undone = must(history.undo(p), 'the undone project');
    assert.notEqual(undone.name, 'After');

    const redone = must(history.redo(undone), 'the redone project');
    assert.equal(redone.name, 'After');
  });

  it('hands back a detached snapshot, not a live reference', () => {
    const history = new History();
    const p = project();
    history.record(p, 'graph.addNode');

    // Mutating the live project after the snapshot must not reach into it.
    p.name = 'Changed';
    p.files.push({ ...must(p.files[0], 'a file'), id: 'extra', path: 'src/extra.py' });

    const restored = must(history.undo(p), 'the restored project');
    assert.notEqual(restored.name, 'Changed');
    assert.ok(!restored.files.some((f) => f.id === 'extra'));

    // And the restored copy is independent of the snapshot still held.
    restored.name = 'Mutated after restore';
    assert.equal(history.state().canRedo, true);
  });

  it('merges rapid edits of the same kind into one step', () => {
    const history = new History();
    const p = project();

    // Typing in a property field fires one command per keystroke.
    for (const name of ['A', 'Ab', 'Abc']) {
      history.record(p, 'graph.setProps');
      p.name = name;
    }
    assert.equal(history.depth, 1, 'three keystrokes should be one undo step');

    const restored = must(history.undo(p), 'the restored project');
    assert.notEqual(restored.name, 'Abc');
  });

  it('does not merge edits of different kinds', () => {
    const history = new History();
    const p = project();
    history.record(p, 'graph.addNode');
    history.record(p, 'graph.connect');
    assert.equal(history.depth, 2);
  });

  it('keeps discrete actions separate however fast they arrive', () => {
    // Adding two nodes quickly is two additions. Merging them would silently
    // cost a fast user an undo step.
    const history = new History();
    const p = project();
    history.record(p, 'graph.addNode');
    history.record(p, 'graph.addNode');
    history.record(p, 'graph.deleteNodes');
    history.record(p, 'graph.deleteNodes');
    assert.equal(history.depth, 4);
  });

  it('discards the redo branch when a new edit lands', () => {
    const history = new History();
    const p = project();

    history.record(p, 'graph.addNode');
    p.name = 'One';
    const undone = must(history.undo(p), 'the undone project');
    assert.equal(history.state().canRedo, true);

    // Editing from the undone state abandons the branch that redo pointed at.
    history.record(undone, 'graph.connect');
    assert.equal(history.state().canRedo, false);
    assert.equal(history.redo(undone), undefined);
  });

  it('returns undefined rather than throwing on an empty stack', () => {
    const history = new History();
    const p = project();
    assert.equal(history.undo(p), undefined);
    assert.equal(history.redo(p), undefined);
    assert.deepEqual(history.state(), {
      canUndo: false,
      canRedo: false,
      undoLabel: undefined,
      redoLabel: undefined,
    });
  });

  it('drops everything when a different project is opened', () => {
    const history = new History();
    const p = project();
    history.record(p, 'graph.addNode');
    history.clear();
    assert.equal(history.state().canUndo, false);
    assert.equal(history.undo(p), undefined);
  });

  it('bounds the stack so a long session cannot grow without limit', () => {
    const history = new History();
    const p = project();
    // Alternate commands so nothing coalesces.
    for (let i = 0; i < 250; i++) {
      history.record(p, i % 2 ? 'graph.addNode' : 'graph.connect');
    }
    assert.equal(history.depth, 100);
  });
});
