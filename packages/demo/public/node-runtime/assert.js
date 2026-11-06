/**
 * `node:assert` and `node:assert/strict` for the JavaScript runner.
 *
 * The methods tests actually use, with Node's comparison rules - `strictEqual`
 * is `Object.is`, `deepStrictEqual` compares prototypes and own enumerable keys,
 * Maps and Sets by content - and messages in Node's wording, since a failing
 * test's message is what the user reads. `inspect` is passed in so this module
 * stays self-contained for the worker to load from source.
 */

export function createAssert(inspect) {
  class AssertionError extends Error {
    constructor({ message, actual, expected, operator, generated }) {
      super(message);
      this.name = 'AssertionError';
      this.code = 'ERR_ASSERTION';
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
      this.generatedMessage = !!generated;
    }
  }

  const fail = (message, fallback, details) => {
    if (message instanceof Error) throw message;
    throw new AssertionError({ ...details, message: message ?? fallback, generated: message === undefined });
  };

  const show = (v) => inspect(v);

  function deepEqual(a, b, strict, seen = new Map()) {
    if (strict ? Object.is(a, b) : a == b || (Number.isNaN(a) && Number.isNaN(b))) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);

    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
      for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), strict, seen)) return false;
      return true;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
      outer: for (const v of a) {
        if (b.has(v)) continue;
        for (const w of b) if (deepEqual(v, w, strict, seen)) continue outer;
        return false;
      }
      return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], strict, seen)) return false;
    }
    return true;
  }

  function matches(error, expected) {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      if (expected.prototype !== undefined && error instanceof expected) return true;
      if (Error.isPrototypeOf(expected) || expected === Error) return false;
      return expected(error) === true;
    }
    if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
    if (typeof expected === 'object' && expected !== null) {
      return Object.keys(expected).every((k) =>
        expected[k] instanceof RegExp ? expected[k].test(String(error?.[k])) : deepEqual(error?.[k], expected[k], true),
      );
    }
    return false;
  }

  function build(strict) {
    const assert = (value, message) => assert.ok(value, message);
    assert.AssertionError = AssertionError;
    assert.ok = (value, message) => {
      if (!value) fail(message, `The expression evaluated to a falsy value:\n\n  assert.ok(${show(value)})\n`, { actual: value, expected: true, operator: '==' });
    };
    assert.fail = (message = 'Failed') => fail(message, 'Failed', { operator: 'fail' });
    assert.strictEqual = (actual, expected, message) => {
      if (!Object.is(actual, expected)) fail(message, `Expected values to be strictly equal:\n\n${show(actual)} !== ${show(expected)}\n`, { actual, expected, operator: 'strictEqual' });
    };
    assert.notStrictEqual = (actual, expected, message) => {
      if (Object.is(actual, expected)) fail(message, `Expected "actual" to be strictly unequal to: ${show(expected)}`, { actual, expected, operator: 'notStrictEqual' });
    };
    assert.deepStrictEqual = (actual, expected, message) => {
      if (!deepEqual(actual, expected, true)) fail(message, `Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ ${show(actual)}\n- ${show(expected)}\n`, { actual, expected, operator: 'deepStrictEqual' });
    };
    assert.notDeepStrictEqual = (actual, expected, message) => {
      if (deepEqual(actual, expected, true)) fail(message, `Expected "actual" not to be strictly deep-equal to: ${show(expected)}`, { actual, expected, operator: 'notDeepStrictEqual' });
    };
    if (strict) {
      assert.equal = assert.strictEqual;
      assert.notEqual = assert.notStrictEqual;
      assert.deepEqual = assert.deepStrictEqual;
      assert.notDeepEqual = assert.notDeepStrictEqual;
    } else {
      assert.equal = (actual, expected, message) => {
        if (!(actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))) fail(message, `${show(actual)} == ${show(expected)}`, { actual, expected, operator: '==' });
      };
      assert.notEqual = (actual, expected, message) => {
        if (actual == expected) fail(message, `${show(actual)} != ${show(expected)}`, { actual, expected, operator: '!=' });
      };
      assert.deepEqual = (actual, expected, message) => {
        if (!deepEqual(actual, expected, false)) fail(message, `Expected values to be loosely deep-equal:\n\n${show(actual)}\n\nshould loosely deep-equal\n\n${show(expected)}`, { actual, expected, operator: 'deepEqual' });
      };
      assert.notDeepEqual = (actual, expected, message) => {
        if (deepEqual(actual, expected, false)) fail(message, `"actual" deepEqual "expected"`, { actual, expected, operator: 'notDeepEqual' });
      };
    }
    assert.throws = (fn, expected, message) => {
      if (typeof expected === 'string') [message, expected] = [expected, undefined];
      try {
        fn();
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      fail(message, 'Missing expected exception.', { operator: 'throws' });
    };
    assert.doesNotThrow = (fn, message) => {
      try {
        fn();
      } catch (error) {
        fail(typeof message === 'string' ? message : undefined, `Got unwanted exception.\nActual message: "${error?.message}"`, { actual: error, operator: 'doesNotThrow' });
      }
    };
    assert.rejects = async (promiseOrFn, expected, message) => {
      if (typeof expected === 'string') [message, expected] = [expected, undefined];
      try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      fail(message, 'Missing expected rejection.', { operator: 'rejects' });
    };
    assert.doesNotReject = async (promiseOrFn, message) => {
      try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
      } catch (error) {
        fail(message, `Got unwanted rejection.\nActual message: "${error?.message}"`, { actual: error, operator: 'doesNotReject' });
      }
    };
    assert.match = (text, pattern, message) => {
      if (!pattern.test(text)) fail(message, `The input did not match the regular expression ${pattern}. Input:\n\n${show(text)}\n`, { actual: text, expected: pattern, operator: 'match' });
    };
    assert.doesNotMatch = (text, pattern, message) => {
      if (pattern.test(text)) fail(message, `The input was expected to not match the regular expression ${pattern}. Input:\n\n${show(text)}\n`, { actual: text, expected: pattern, operator: 'doesNotMatch' });
    };
    return assert;
  }

  const assert = build(false);
  assert.strict = build(true);
  assert.strict.strict = assert.strict;
  return assert;
}
