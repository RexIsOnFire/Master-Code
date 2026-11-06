"""Audit the generated tree for functions called but never defined, and for
tables referenced in SQL but never created by a migration."""
import ast
import builtins
import io
import os
import re
import sys

ROOT = sys.argv[1]
SRC = os.path.join(ROOT, 'src')

defined = set()
trees = {}

for base, _dirs, names in os.walk(SRC):
    for name in names:
        if not name.endswith('.py'):
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, SRC).replace(os.sep, '/')
        tree = ast.parse(io.open(path, encoding='utf-8').read())
        trees[rel] = tree
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)

BUILTINS = set(dir(builtins))

undefined = {}
for rel, tree in sorted(trees.items()):
    local, imported = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            local.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            local.add(node.id)
        elif isinstance(node, ast.arg):
            local.add(node.arg)
        elif isinstance(node, ast.Import):
            for a in node.names:
                imported.add((a.asname or a.name).split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                imported.add(a.asname or a.name)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            local.add(node.name)

    called = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            called.add(node.func.id)

    for name in sorted(called - local - imported - BUILTINS - defined):
        undefined.setdefault(rel, []).append(name)

print('=' * 72)
print('FUNCTIONS CALLED BUT NEVER DEFINED ANYWHERE IN THE PROJECT')
print('=' * 72)
total = 0
for rel, names in sorted(undefined.items()):
    print('  %-34s %s' % (rel, ', '.join(sorted(set(names)))))
    total += len(set(names))
print('  -> %d distinct missing implementations' % total)

# ---------------------------------------------------------------------------
created = set()
for name in ('soar/storage/schema.py', 'soar/storage/schema_ops.py'):
    path = os.path.join(SRC, name)
    if not os.path.exists(path):
        continue
    for match in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )?(\w+)',
                             io.open(path, encoding='utf-8').read()):
        created.add(match.group(1))

# Regex false positives from SQL fragments rather than table references.
NOT_TABLES = {'now', 'acknowledged_at', 'closed_at', 'contained_at', 'LATERAL'}

referenced = set()
for base, _dirs, names in os.walk(SRC):
    for name in names:
        if not name.endswith('.py'):
            continue
        text = io.open(os.path.join(base, name), encoding='utf-8').read()
        # GRANT/REVOKE ... FROM <role> names a role, not a table, and pg_* is a
        # system catalogue. Counting either reports tables that were never meant
        # to exist, and an audit with known false positives is one people learn
        # to skip past.
        # Comments are prose, and prose contains the word UPDATE. Stripping them
        # first is the lesson the import scanner already learned the hard way.
        sql_text = re.sub(r'#[^\n]*', ' ', text)
        sql_text = re.sub(r'\b(?:GRANT|REVOKE)\b[^;]*?;', ' ', sql_text, flags=re.S)
        for match in re.finditer(r'\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)\b', sql_text):
            table = match.group(1)
            if (table.isupper() or table in ('SELECT',)
                    or table.startswith('pg_')
                    # A system catalogue is queried, never created: the
                    # purge reads information_schema to work out its own
                    # delete order.
                    or table in ('information_schema',)):
                continue
            referenced.add(table)

print()
print('=' * 72)
print('TABLES USED IN SQL BUT NEVER CREATED BY A MIGRATION')
print('=' * 72)
missing_tables = sorted(t for t in referenced - created - NOT_TABLES
                        if not t.startswith('_'))
for table in missing_tables:
    print('  ', table)
print('  -> %d missing tables' % len(missing_tables))
print()
print('tables created:', len(created))

# ---------------------------------------------------------------------------
pages = set()
for base, _dirs, names in os.walk(ROOT):
    if 'node_modules' in base:
        continue
    for name in names:
        if name.endswith('.html'):
            pages.add(name)

linked = set()
for base, _dirs, names in os.walk(os.path.join(SRC, 'web')):
    for name in names:
        text = io.open(os.path.join(base, name), encoding='utf-8').read()
        for match in re.finditer(r'"/([a-z_]+\.html)', text):
            linked.add(match.group(1))

print()
print('=' * 72)
print('PAGES THE UI LINKS TO THAT DO NOT EXIST')
print('=' * 72)
print('  exist: ', ', '.join(sorted(pages)))
print('  missing:', ', '.join(sorted(linked - pages)) or 'none')

# ---------------------------------------------------------------------------
# Settings read but never declared.
#
# read_environment_overrides() only copies SOAR_* variables for keys that are
# already in default_settings(), so a setting the code requires but the defaults
# never mention can never be supplied - and require_setting() then refuses to
# start the process. job_signing_key was exactly this: declared nowhere, read by
# build_service_context, and therefore fatal to every role in the product.
# ---------------------------------------------------------------------------
config_path = os.path.join(SRC, 'soar', 'platform', 'config.py')
undeclared = {}
if os.path.exists(config_path):
    config_text = io.open(config_path, encoding='utf-8').read()
    declared = set(re.findall(r"'([a-z_]+)':", config_text))
    declared |= set(re.findall(r'settings\["([a-z_]+)"\] =', config_text))
    declared |= {'root_key', 'root_key_path', 'root_key_inline'}

    for base, _dirs, names in os.walk(SRC):
        for name in names:
            if not name.endswith('.py'):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, SRC).replace(os.sep, '/')
            if rel.endswith('platform/config.py'):
                continue
            text = io.open(path, encoding='utf-8').read()
            for match in re.finditer(r'require_setting\(settings,\s*"([^"]+)"\)', text):
                if match.group(1) not in declared:
                    undeclared.setdefault(match.group(1), set()).add(rel)
            for match in re.finditer(r'settings(?:\.get)?[\[(]"([a-z_]+)"', text):
                if match.group(1) not in declared:
                    undeclared.setdefault(match.group(1), set()).add(rel)

print()
print('=' * 72)
print('SETTINGS READ BUT NEVER DECLARED IN default_settings()')
print('=' * 72)
for name, where in sorted(undeclared.items()):
    print('  %-26s %s' % (name, ', '.join(sorted(where))))
print('  -> %d undeclared settings' % len(undeclared))

# ---------------------------------------------------------------------------
# Module constants the Python backend renamed.
#
# The backend lower-cases a module variable's declared name, so an UPPER_CASE
# one is declared as something the raw Custom Code bodies do not spell. Valid
# Python, NameError at run time, invisible to a byte-compile. Same family as the
# JavaScript camelCasing and the stripped leading underscore - and this one took
# out every role in the product via SERVICE_REGISTRY, and every login attempt
# for an unknown user via PLACEHOLDER_HASH.
# ---------------------------------------------------------------------------
renamed = {}
for base, _dirs, names in os.walk(SRC):
    for name in names:
        if not name.endswith('.py'):
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, SRC).replace(os.sep, '/')
        text = io.open(path, encoding='utf-8').read()
        declared = set(re.findall(r'^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\w+.*=', text, re.M))
        for used in set(re.findall(r'(?<![\w.])([A-Z][A-Z0-9_]{2,})(?![\w])', text)):
            if used in declared:
                continue
            if used.lower() in declared:
                renamed.setdefault(rel, set()).add('%s (declared as %s)' % (used, used.lower()))

print()
print('=' * 72)
print('MODULE CONSTANTS USED BY A NAME THE BACKEND DID NOT DECLARE')
print('=' * 72)
for rel, names in sorted(renamed.items()):
    print('  %-36s %s' % (rel, ', '.join(sorted(names))))
print('  -> %d files affected' % len(renamed))
