"""Find functions and classes that nothing references.

The inverse of audit-gaps.py. Some unreferenced functions are correct - an entry
point, a handler reached by name through a registry, a browser handler bound from
markup by data-mcode-events. Those are classified rather than reported, so what
is left is the code that genuinely has no caller.
"""
import ast
import io
import json
import os
import re
import sys

ROOT = sys.argv[1]
SRC = os.path.join(ROOT, 'src')

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
defs = {}          # name -> module
py_text = {}

for base, _dirs, names in os.walk(SRC):
    for name in names:
        if not name.endswith('.py'):
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, SRC).replace(os.sep, '/')
        source = io.open(path, encoding='utf-8').read()
        py_text[rel] = source
        for node in ast.parse(source).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs.setdefault(node.name, []).append(rel)

# Every identifier that appears anywhere as a load/call/attribute or a string.
referenced = {}
for rel, source in py_text.items():
    tree = ast.parse(source)
    seen = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            seen.add(node.id)
        elif isinstance(node, ast.Attribute):
            seen.add(node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # Registries map a name to a function by string; a dispatch table
            # entry is a reference even though it is not a call.
            seen.add(node.value)
    for name in seen:
        referenced.setdefault(name, set()).add(rel)

# Names the browser reaches over HTTP, or the CLI reaches as an entry point.
ENTRY_POINTS = {'main', 'on_request', 'on_ready', 'run_migrations'}

unused_py = {}
for name, modules in sorted(defs.items()):
    home = modules[0]
    users = referenced.get(name, set()) - {home}
    if users:
        continue
    # Referenced inside its own module counts, except by its own definition.
    own = py_text[home]
    body_hits = len(re.findall(r'(?<![\w.])' + re.escape(name) + r'\s*\(', own))
    if body_hits:
        continue
    if name in ENTRY_POINTS:
        continue
    unused_py.setdefault(home, []).append(name)

# ---------------------------------------------------------------------------
# JavaScript: handlers are bound from markup, and modules publish to a registry.
# ---------------------------------------------------------------------------
js_defs = {}
js_text = {}
for base, _dirs, names in os.walk(os.path.join(SRC, 'web')):
    for name in names:
        if not name.endswith('.js'):
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, SRC).replace(os.sep, '/')
        source = io.open(path, encoding='utf-8').read()
        js_text[rel] = source
        for match in re.finditer(r'export (?:async )?function (\w+)', source):
            js_defs.setdefault(match.group(1), []).append(rel)

markup_handlers = set()
for base, _dirs, names in os.walk(ROOT):
    if 'node_modules' in base or os.sep + 'src' + os.sep in base + os.sep:
        continue
    for name in names:
        if not name.endswith('.html'):
            continue
        text = io.open(os.path.join(base, name), encoding='utf-8').read()
        for match in re.finditer(r'data-mcode-events="([^"]+)"', text):
            for pair in match.group(1).split(','):
                _, _, handler = pair.partition(':')
                markup_handlers.add(handler.strip())

unused_js = {}
for name, modules in sorted(js_defs.items()):
    home = modules[0]
    if name in markup_handlers:
        continue
    hits = 0
    for rel, source in js_text.items():
        # A reference is a call, an argument, or an entry in the shared registry.
        hits += len(re.findall(r'(?<![\w.$])' + re.escape(name) + r'(?![\w])', source))
        if rel == home:
            # Its own declaration is not a use of it.
            # Anchor the end, or `renderNode` also matches the declaration of
            # `renderNodeElement` and the name looks unused when it is not.
            hits -= len(re.findall(
                r'export (?:async )?function ' + re.escape(name) + r'(?![\w])', source))
    if hits <= 0:
        unused_js.setdefault(home, []).append(name)

# ---------------------------------------------------------------------------
print('=' * 72)
print('PYTHON: DEFINED BUT NEVER REFERENCED')
print('=' * 72)
total = 0
for rel, names in sorted(unused_py.items()):
    print('  %-36s %s' % (rel, ', '.join(names)))
    total += len(names)
print('  -> %d' % total)

print()
print('=' * 72)
print('JAVASCRIPT: EXPORTED BUT NEVER CALLED (and not bound from markup)')
print('=' * 72)
total_js = 0
for rel, names in sorted(unused_js.items()):
    print('  %-36s %s' % (rel, ', '.join(names)))
    total_js += len(names)
print('  -> %d' % total_js)
