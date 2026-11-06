"""Find JavaScript calls to names that do not exist.

The JavaScript backend camelCases declarations. A Custom Code body that calls a
function by the snake_case name it was declared with therefore calls something
that is not there - valid syntax, ReferenceError at run time, invisible to
`node --check`.
"""
import io
import os
import re
import sys

ROOT = sys.argv[1]
WEB = os.path.join(ROOT, 'src', 'web')

GLOBALS = {
    'document', 'window', 'console', 'location', 'history', 'navigator',
    'localStorage', 'sessionStorage', 'fetch', 'setTimeout', 'setInterval',
    'clearInterval', 'clearTimeout', 'JSON', 'Object', 'Array', 'String',
    'Number', 'Boolean', 'Math', 'Date', 'Error', 'Promise', 'Set', 'Map',
    'URLSearchParams', 'EventSource', 'CustomEvent', 'Event', 'FormData',
    'structuredClone', 'matchMedia', 'encodeURIComponent', 'decodeURIComponent',
    'parseInt', 'parseFloat', 'isNaN', 'alert', 'confirm', 'prompt', 'require',
    'HTMLElement', 'Number', 'Array', 'globalThis', 'if', 'for', 'while',
    'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'else',
    'do', 'super', 'this',
}


def camel(name):
    return re.sub(r'_([a-z0-9])', lambda m: m.group(1).upper(), name)


declared = {}
sources = {}
for name in sorted(os.listdir(WEB)):
    if not name.endswith('.js'):
        continue
    text = io.open(os.path.join(WEB, name), encoding='utf-8').read()
    sources[name] = text
    for match in re.finditer(r'export (?:async )?function (\w+)', text):
        declared[match.group(1)] = name

# Names published into the shared registry are reachable cross-module.
registry = set()
for text in sources.values():
    block = re.search(r'Object\.assign\(globalThis\.SOAR, \{(.*?)\}\)', text, re.S)
    if block:
        registry.update(re.findall(r'(\w+)\s*,', block.group(1)))

problems = {}
for name, text in sources.items():
    # Locals declared inside this file's bodies.
    local = set(re.findall(r'(?:const|let|var)\s+(\w+)\s*=', text))
    local |= set(re.findall(r'function\s+(\w+)', text))
    local |= set(re.findall(r'\{([^{}]*?)\}\s*=\s*globalThis\.SOAR', text) and
                 re.findall(r'(\w+)', re.search(r'\{([^{}]*?)\}\s*=\s*globalThis\.SOAR', text).group(1))
                 if re.search(r'\{([^{}]*?)\}\s*=\s*globalThis\.SOAR', text) else [])
    for match in re.finditer(r'\{([^{}]*?)\}\s*=\s*globalThis\.SOAR', text):
        local |= set(re.findall(r'(\w+)', match.group(1)))

    for match in re.finditer(r'(?<![\w.$])([a-z_][A-Za-z0-9_]*)\s*\(', text):
        called = match.group(1)
        if called in GLOBALS or called in local or called in declared:
            continue
        fixed = camel(called)
        if fixed != called and (fixed in declared or fixed in registry):
            line = text[:match.start()].count('\n') + 1
            problems.setdefault(name, []).append((line, called, fixed))

print('=' * 74)
print('JAVASCRIPT CALLS TO A NAME THE BACKEND RENAMED')
print('=' * 74)
total = 0
for name, hits in sorted(problems.items()):
    print('  ' + name)
    seen = set()
    for line, called, fixed in hits:
        if called in seen:
            continue
        seen.add(called)
        print('      line %-5d %s()  ->  should be %s()' % (line, called, fixed))
        total += 1
print('  -> %d distinct broken call names' % total)
