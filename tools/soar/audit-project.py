"""Audit the Master Code project itself, not the code it generates.

A project is a graph of files, graphs, nodes, edges and UI documents. Each of
those can rot in its own way: a file nobody imports, a graph attached to nothing,
a node no execution path reaches, an export nobody consumes, the same Custom Code
body pasted into two places.

None of it shows up in the generated output as an error - it shows up as a
project that is bigger than the product, which is how a codebase stops being
readable. Run:

    python tools/soar/audit-project.py projects/master-soar
"""
import collections
import hashlib
import io
import json
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'projects/master-soar'


def load(name):
    return json.load(io.open(os.path.join(ROOT, name), encoding='utf-8'))


project = load('project.json')
architecture = load('architecture.json')
files = load('files.json')['files']

graphs = []
for name in sorted(os.listdir(os.path.join(ROOT, 'graphs'))):
    graphs.append(load(os.path.join('graphs', name)))

ui_docs = {}
for name in sorted(os.listdir(os.path.join(ROOT, 'ui'))):
    ui_docs[name] = load(os.path.join('ui', name))

by_id = {f['id']: f for f in files}
graph_by_file = {g.get('fileId'): g for g in graphs}

findings = collections.OrderedDict()


def report(title, rows, note=''):
    findings[title] = (rows, note)


# ---------------------------------------------------------------------------
# 1. Files with nothing in them.
# ---------------------------------------------------------------------------
empty = []
for f in files:
    if f['id'] in graph_by_file:
        continue
    if (f.get('options') or {}).get('ui'):
        continue
    if f['language'] in ('css',):          # a stylesheet is rules, not a graph
        continue
    empty.append('%s  (%s, role=%s)' % (f['path'], f['language'], f['role']))
report('FILES WITH NEITHER A GRAPH NOR A UI DOCUMENT', empty,
       'A declared file that carries nothing generates an empty module.')

# ---------------------------------------------------------------------------
# 2. Graphs attached to a file that no longer exists.
# ---------------------------------------------------------------------------
orphan_graphs = ['%s  (fileId=%s)' % (g['name'], g.get('fileId'))
                 for g in graphs if g.get('fileId') not in by_id]
report('GRAPHS WHOSE FILE IS GONE', orphan_graphs,
       'The graph is still written out and nothing reads it.')

# ---------------------------------------------------------------------------
# 3. UI documents no page references.
# ---------------------------------------------------------------------------
referenced_ui = set()
for f in files:
    ui = (f.get('options') or {}).get('ui')
    if isinstance(ui, str):
        referenced_ui.add(ui)
    elif isinstance(ui, dict) and ui.get('id'):
        referenced_ui.add(ui['id'])
loose_ui = []
for name, doc in ui_docs.items():
    if doc.get('id') and doc['id'] not in referenced_ui and name[:-5] not in referenced_ui:
        loose_ui.append('%s  (%s)' % (name, doc.get('title', '')))
report('UI DOCUMENTS NO FILE POINTS AT', loose_ui,
       'Written to disk, opened by nobody, and shipped in the project.')

# ---------------------------------------------------------------------------
# 4. Nodes no edge touches.
#
# A node with no edge at all is not wired into anything. Entry points and
# declarations are legitimately unconnected, so those are excluded by type.
# ---------------------------------------------------------------------------
STANDALONE = (
    'entry/', 'oop/', 'data/comment', 'dom/on-ready',
    'event/handler', 'test/case', 'custom/code',
)
islands = []
for g in graphs:
    touched = set()
    for e in g.get('edges') or []:
        touched.add(e['from']['node'])
        touched.add(e['to']['node'])
    for n in g['nodes']:
        if n['id'] in touched:
            continue
        if any(n['type'].startswith(p) for p in STANDALONE):
            continue
        islands.append('%-34s %s  %s' % (g['name'], n['type'], n['id']))
report('NODES WITH NO EDGE IN OR OUT', islands,
       'Placed on the canvas and joined to nothing; it emits nothing.')

# ---------------------------------------------------------------------------
# 5. Exports naming something the file does not declare.
#
# NOT "exported but never imported" - the saved project cannot answer that.
# setGeneratedImports overwrites file.imports at generation time with what the
# IR referenced, and a Custom Code body is opaque to it, so the import edges on
# disk are incomplete by construction. audit-unused.py answers that question
# properly by reading the generated code.
#
# What the project model CAN answer is whether an export points at anything: a
# file promising a symbol its own graph never declares is a promise the import
# wirer will resolve to nothing.
# ---------------------------------------------------------------------------
phantom_exports = []
for f in files:
    g = graph_by_file.get(f['id'])
    if not g:
        continue
    declared_here = set()
    # A declaration is not always a 'name' prop: an event/handler names itself
    # with 'event', dom/on-ready always emits onReady, and a graph variable is
    # a module-level declaration that lives outside the node list entirely.
    for n in g['nodes']:
        for key in ('name', 'className', 'event'):
            if n['props'].get(key):
                declared_here.add(str(n['props'][key]))
        # Entry nodes name their function by type rather than by a prop.
        if n['type'] == 'dom/on-ready':
            declared_here.add('onReady')
        if n['type'] == 'entry/main':
            declared_here.add('main')
        if n['type'] == 'net/on-request':
            declared_here.update(('onRequest', 'serve'))
    for variable in g.get('variables') or []:
        if isinstance(variable, dict) and variable.get('name'):
            declared_here.add(str(variable['name']))
    for symbol in f.get('exports') or []:
        if symbol['name'] not in declared_here:
            phantom_exports.append('%-42s %s' % (f['path'], symbol['name']))
report('EXPORTS THE FILE NEVER DECLARES', phantom_exports,
       'The file promises a symbol its own graph does not define.')

# ---------------------------------------------------------------------------
# 6. The same Custom Code body in two places.
# ---------------------------------------------------------------------------
bodies = collections.defaultdict(list)
for g in graphs:
    for n in g['nodes']:
        if n['type'] != 'custom/code':
            continue
        code = str(n['props'].get('code') or '')
        # Compare what the code does, not how it is laid out, and ignore the
        # import header the builder prepends.
        stripped = NL = '\n'
        lines = [ln.rstrip() for ln in code.split('\n')
                 if ln.strip() and not ln.strip().startswith(('#', 'from ', 'import ', 'const {'))]
        if len(lines) < 5:
            continue
        digest = hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()[:12]
        bodies[digest].append('%s :: %s' % (g['name'], n['props'].get('name', n['id'])))

duplicated = []
for digest, where in sorted(bodies.items()):
    if len(where) > 1:
        duplicated.append('%s  x%d' % (digest, len(where)))
        for w in where:
            duplicated.append('      %s' % w)
report('IDENTICAL CUSTOM CODE BODIES', duplicated,
       'The same logic in two graphs: fix it in one and the other keeps the bug.')

# ---------------------------------------------------------------------------
# 7. The same function name declared in two files.
# ---------------------------------------------------------------------------
declared = collections.defaultdict(list)
for g in graphs:
    path = by_id.get(g.get('fileId'), {}).get('path', g['name'])
    for n in g['nodes']:
        name = n['props'].get('name')
        if n['type'] in ('entry/function', 'custom/code') and name:
            declared[name].append(path)
# Only a name that is also EXPORTED can collide: the import wirer skips an
# ambiguous export, so a cross-file call resolves to nothing. A repeated
# module-local helper - each browser module has its own handler binder - is
# module-scoped in both Python and JavaScript and collides with nothing.
exported_from = collections.defaultdict(set)
for f in files:
    for symbol in f.get('exports') or []:
        exported_from[symbol['name']].add(f['path'])

collisions = []
for name, paths in sorted(declared.items()):
    unique = sorted(set(paths))
    # Python only. The import wirer resolves cross-file names for Python, so an
    # ambiguous export there silently breaks a call. Browser modules do not
    # import each other - they read named entries out of globalThis.SOAR - and
    # a per-module private helper repeated in five of them is module-scoped in
    # every one, colliding with nothing.
    python_only = [p for p in unique if p.endswith('.py')]
    if len(python_only) > 1 and len(exported_from.get(name, set())) > 1:
        collisions.append('%-32s %s' % (name, ', '.join(python_only)))
report('ONE NAME DECLARED IN SEVERAL FILES', collisions,
       'The import wirer skips an ambiguous name, so a cross-file call to it '
       'silently resolves to nothing.')

# ---------------------------------------------------------------------------
# 8. Modules that hold no files, and declared interface members that do not exist.
# ---------------------------------------------------------------------------
modules = architecture.get('modules') or project.get('modules') or []
files_by_module = collections.Counter(f.get('moduleId') for f in files)
hollow = ['%s  (%s)' % (m['name'], m.get('directory', ''))
          for m in modules if not files_by_module.get(m['id'])]
report('MODULES WITH NO FILES', hollow, '')

all_exports = {s['name'] for f in files for s in (f.get('exports') or [])}
phantom = []
for m in modules:
    for member in m.get('interface') or []:
        if member['name'] not in all_exports:
            phantom.append('%-14s %s' % (m['name'], member['name']))
report('MODULE INTERFACE NAMES NOTHING EXPORTS', phantom,
       'The module advertises a member no file provides.')

# ---------------------------------------------------------------------------
print('=' * 74)
print('MASTER SOAR PROJECT AUDIT')
print('=' * 74)
print('  %d modules, %d files, %d graphs, %d nodes, %d UI documents'
      % (len(modules), len(files), len(graphs),
         sum(len(g['nodes']) for g in graphs), len(ui_docs)))

total = 0
for title, (rows, note) in findings.items():
    print()
    print('-' * 74)
    print(title)
    if note:
        print('  ' + note)
    print('-' * 74)
    for row in rows:
        print('  ' + row)
    count = len([r for r in rows if not r.startswith('      ')])
    total += count
    print('  -> %d' % count)

print()
print('=' * 74)
print('TOTAL FINDINGS: %d' % total)
