"""Find repetition in the Master SOAR project.

Exact-match duplicate detection catches almost nothing in practice: two copies
of the same logic nearly always differ by a name, a literal or a line. This
looks for four kinds of repetition that an exact match misses.

  1. Near-duplicate Custom Code bodies      (token similarity, not equality)
  2. Repeated statement blocks              (the same 6 lines in two places)
  3. Duplicated SQL                          (the same query written twice)
  4. Repeated UI subtrees                    (the same panel built twice)

Run:  python tools/soar/audit-duplication.py projects/master-soar
"""
import collections
import difflib
import io
import json
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'projects/master-soar'
NEAR = 0.88          # similarity at which two bodies are "the same thing twice"
BLOCK = 6            # consecutive statements that count as a repeated block


def load(path):
    return json.load(io.open(os.path.join(ROOT, path), encoding='utf-8'))


files = {f['id']: f for f in load('files.json')['files']}
graphs = [load(os.path.join('graphs', n))
          for n in sorted(os.listdir(os.path.join(ROOT, 'graphs')))]
ui_docs = {n: load(os.path.join('ui', n))
           for n in sorted(os.listdir(os.path.join(ROOT, 'ui')))}


def where(graph, node):
    path = files.get(graph.get('fileId'), {}).get('path', graph['name'])
    return '%s :: %s' % (path, node['props'].get('name') or node['id'])


def body_lines(code):
    """Statements only: no comments, no blank lines, no generated import header."""
    out = []
    for line in str(code or '').split('\n'):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if stripped.startswith(('from ', 'import ', 'const {')):
            continue
        out.append(stripped)
    return out


def has_structure(window):
    """Whether a normalised window still says anything.

    Counts the tokens that survived normalisation - identifiers, attributes,
    keywords - and ignores the S and N placeholders. Three distinct ones is
    the point where a match starts meaning two pieces of code do the same
    thing rather than two pieces of code being six lines long.
    """
    real = {word for word in re.findall(r'[A-Za-z_][A-Za-z_0-9]*', window)
            if word not in ('S', 'N')}
    return len(real) >= 3


def shape(lines):
    """Normalise away the things two copies usually differ by."""
    text = '\n'.join(lines)
    text = re.sub(r'"[^"]*"|\'[^\']*\'', 'S', text)     # string literals
    text = re.sub(r'\b\d+\b', 'N', text)                # numbers
    return re.sub(r'\s+', ' ', text)


bodies = []
for g in graphs:
    for n in g['nodes']:
        if n['type'] != 'custom/code':
            continue
        lines = body_lines(n['props'].get('code'))
        if len(lines) >= 8:
            bodies.append((where(g, n), lines, shape(lines)))

findings = []

# ---------------------------------------------------------------------------
# 1. Near-duplicate bodies.
# ---------------------------------------------------------------------------
near = []
seen_pairs = set()
for i, (a_where, a_lines, a_shape) in enumerate(bodies):
    for b_where, b_lines, b_shape in bodies[i + 1:]:
        if abs(len(a_lines) - len(b_lines)) > max(4, len(a_lines) * 0.4):
            continue
        ratio = difflib.SequenceMatcher(None, a_shape, b_shape).ratio()
        if ratio < NEAR:
            continue
        key = tuple(sorted((a_where, b_where)))
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        near.append('%3d%%  %s' % (ratio * 100, a_where))
        near.append('      %s  (%d and %d statements)'
                    % (b_where, len(a_lines), len(b_lines)))
findings.append(('NEAR-DUPLICATE CUSTOM CODE BODIES', near,
                 'Similar past %d%% once names and literals are normalised away.'
                 % int(NEAR * 100)))

# ---------------------------------------------------------------------------
# 2. Repeated statement blocks across different bodies.
# ---------------------------------------------------------------------------
blocks = collections.defaultdict(set)
for a_where, lines, _ in bodies:
    for start in range(len(lines) - BLOCK + 1):
        window = shape(lines[start:start + BLOCK])
        if not has_structure(window):
            # Six lines of pure string literal normalise to 'S S S S S S' and
            # match every other six such lines. That is the fingerprint being
            # content-free, not two copies of anything.
            continue
        blocks[window].add(a_where)

repeated = []
for window, places in sorted(blocks.items(), key=lambda kv: -len(kv[1])):
    if len(places) < 2:
        continue
    repeated.append('%d places: %s' % (len(places), window[:96]))
    for place in sorted(places):
        repeated.append('      %s' % place)
findings.append(('THE SAME %d STATEMENTS IN SEVERAL BODIES' % BLOCK, repeated,
                 'A block worth extracting, or a copy that will be fixed once.'))

# ---------------------------------------------------------------------------
# 3. Duplicated SQL.
# ---------------------------------------------------------------------------
sql_seen = collections.defaultdict(set)
SQL = re.compile(r'\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b.{20,}', re.I)
for g in graphs:
    for n in g['nodes']:
        if n['type'] != 'custom/code':
            continue
        code = str(n['props'].get('code') or '')
        # Statements are built by concatenating adjacent string literals.
        for match in re.finditer(r'((?:"[^"]*"\s*){2,})', code):
            text = ' '.join(re.findall(r'"([^"]*)"', match.group(1)))
            text = re.sub(r'\s+', ' ', text).strip()
            if len(text) > 60 and SQL.search(text):
                sql_seen[text].add(where(g, n))

dup_sql = []
for text, places in sorted(sql_seen.items(), key=lambda kv: -len(kv[1])):
    if len(places) < 2:
        continue
    dup_sql.append('%d places: %s' % (len(places), text[:96]))
    for place in sorted(places):
        dup_sql.append('      %s' % place)
findings.append(('THE SAME QUERY WRITTEN MORE THAN ONCE', dup_sql,
                 'Two copies of a query drift; one gets a new column and the '
                 'other quietly does not.'))

# ---------------------------------------------------------------------------
# 4. Repeated UI subtrees.
# ---------------------------------------------------------------------------
def subtree(node):
    kids = node.get('children') or []
    return '%s[%s]{%s}' % (node.get('kind'), ','.join(node.get('classes') or []),
                           ''.join(subtree(k) for k in kids))


trees = collections.defaultdict(set)
for name, doc in ui_docs.items():
    stack = list(doc.get('root') or [])
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        kids = node.get('children') or []
        stack.extend(kids)
        if len(kids) >= 3:
            trees[subtree(node)].add('%s :: %s' % (name, node.get('id')))

dup_ui = []
for signature, places in sorted(trees.items(), key=lambda kv: -len(kv[1])):
    # The shared shell is on every page on purpose; it is built by one function.
    if len(places) < 3 or len(signature) < 80:
        continue
    dup_ui.append('%d pages: %s' % (len(places), signature[:96]))
findings.append(('THE SAME UI SUBTREE ON MANY PAGES', dup_ui,
                 'Expected where one function builds it; a finding where it '
                 'was written out by hand more than once.'))

# ---------------------------------------------------------------------------
print('=' * 74)
print('MASTER SOAR DUPLICATION AUDIT')
print('=' * 74)
print('  %d Custom Code bodies of 8+ statements, %d UI documents'
      % (len(bodies), len(ui_docs)))

total = 0
for title, rows, note in findings:
    print()
    print('-' * 74)
    print(title)
    print('  ' + note)
    print('-' * 74)
    for row in rows[:60]:
        print('  ' + row)
    if len(rows) > 60:
        print('  ... %d more' % (len(rows) - 60))
    count = len([r for r in rows if not r.startswith('      ')])
    total += count
    print('  -> %d' % count)

print()
print('=' * 74)
print('TOTAL: %d' % total)
