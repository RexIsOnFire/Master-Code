/**
 * Practice challenges, easy to hard.
 *
 * Each one is language-agnostic on purpose. A node definition may never branch
 * on the target language, so a challenge written once is offered in every
 * language whose backend declares the features it needs — which is also the
 * cheapest honest way to say "learn this in Rust" without writing the content
 * ten times.
 *
 * A challenge is not a template. A template hands you a working project; a
 * challenge hands you a starting point and a definition of done, and the
 * checker runs the real program and compares its real output. There is no
 * marking of the graph's shape — several solutions are correct, and grading the
 * drawing rather than the behaviour would punish the good ones.
 */

import type { LanguageFeatures } from '../backends/backend.ts';
import type { NewProjectOptions } from '../project/builder.ts';
import { GraphBuilder, addFile, grant, newProject } from '../project/builder.ts';
import type { NodeRegistry } from '../nodes/definition.ts';
import type { Capability } from '../ir/ir.ts';
import type { Project } from '../model/project.ts';

export type Difficulty = 'tutorial' | 'easy' | 'medium' | 'hard';

export interface ChallengeContext {
  registry: NodeRegistry;
  options: NewProjectOptions;
  /** Where the entry file goes for the chosen language. */
  entryPath: string;
}

export interface Challenge {
  id: string;
  title: string;
  difficulty: Difficulty;
  /** One or two sentences: what to build. */
  brief: string;
  /** Ordered steps. The tutorial ones are detailed; later ones are goals. */
  steps: string[];
  /** Revealed one at a time, so a hint is a choice rather than a spoiler. */
  hints: string[];
  /**
   * Language features the solution needs, so a backend lacking one is not
   * offered the challenge. None of the current set need anything — branching
   * and looping are universal — but a future challenge about classes or async
   * would, and guessing at a flag that does not exist is worse than none.
   */
  needs?: (keyof LanguageFeatures)[];
  /** Capabilities the finished program will use, granted up front. */
  grants?: Capability[];
  /** Arguments the checker passes when running. */
  args?: string[];
  /** Standard input the checker supplies. */
  stdin?: string;
  /**
   * What the output must contain, in order. Matched case-insensitively against
   * the trimmed output with whitespace collapsed, so `[1, 2]` and `[1 2]` both
   * pass — the exercise is the logic, not a language's list formatting.
   */
  expect: string[];
  /** Shown after a pass: what the exercise was really about. */
  afterword?: string;
  /** Builds the starting project. Usually an entry point and nothing else. */
  start(ctx: ChallengeContext): Project;
}

// ---------------------------------------------------------------------------

/** A project with one entry file holding a Main node, and nothing else. */
function blankStart(ctx: ChallengeContext, id: string, grants: Capability[] = ['stdio']): Project {
  const project = newProject({ ...ctx.options, template: `challenge/${id}` });
  const { graph } = addFile(project, {
    path: ctx.entryPath,
    language: ctx.options.language,
    role: 'entry',
    kind: 'hybrid',
    graph: { name: 'main', style: 'procedural' },
  });
  if (graph) new GraphBuilder(project, ctx.registry, graph).add('entry/main');
  for (const capability of grants) grant(project, capability);
  return project;
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'first-graph',
    title: 'Your first graph',
    difficulty: 'tutorial',
    brief: 'Make the program print a greeting. This one walks you through every click.',
    steps: [
      'The canvas already has a **Main** node. That is where the program starts — the wire leaving its `body` port is the order things happen in.',
      'Open the **Nodes** panel on the left and search for "Print". Drag it onto the canvas.',
      'Drag from **Main**\'s `body` port to the **Print** node\'s left-hand `in` port. A wire connects them; that is the execution order.',
      'Select the Print node. In **Properties** on the right, find its `value` input and type `Hello, Master Code!` as the default.',
      'Press **Generate** in the toolbar, then open the **Node code** tab at the bottom and click the Print node — that is the line it produced.',
      'Press **Run**.',
    ],
    hints: [
      'Ports only connect when the types match. Execution ports are the ones at the far left and right edges.',
      'A port with nothing wired to it uses its default, which you set in the Properties panel.',
    ],
    expect: ['hello, master code'],
    afterword:
      'That is the whole model: nodes lower to an intermediate representation, and a backend turns that into real source. Nothing you drew was language-specific.',
    start: (ctx) => blankStart(ctx, 'first-graph'),
  },

  {
    id: 'add-two',
    title: 'Add two numbers',
    difficulty: 'easy',
    brief: 'Print the sum of 17 and 25.',
    steps: [
      'Add an **Arithmetic** node and set its operator to `+`.',
      'Give its two inputs the values 17 and 25 — either as port defaults or with two **Literal** nodes.',
      'Wire the result into a **Print**, and the Print into Main.',
    ],
    hints: [
      'A port default is quicker than a Literal node when the value never changes.',
      'The Arithmetic node\'s operator is a property, not an input.',
    ],
    expect: ['42'],
    start: (ctx) => blankStart(ctx, 'add-two'),
  },

  {
    id: 'even-or-odd',
    title: 'Even or odd',
    difficulty: 'easy',
    brief: 'Print "even" when a number divides by two, "odd" otherwise. Use 7.',
    steps: [
      'Use **Arithmetic** with the `%` operator to take the remainder of 7 divided by 2.',
      'Compare that to 0 with a **Compare** node.',
      'Feed the result into an **If** node, and print a different word from each branch.',
    ],
    hints: [
      'The If node has two execution outputs: `then` and `else`. Wire a Print to each.',
      'Remember to wire Main into the If, or nothing runs.',
    ],
    expect: ['odd'],
    start: (ctx) => blankStart(ctx, 'even-or-odd'),
  },

  {
    id: 'count-to-ten',
    title: 'Count to ten',
    difficulty: 'easy',
    brief: 'Print the numbers 1 to 10, one per line.',
    steps: [
      'Add a **For Range** node counting from 1 to 11.',
      'Its `body` execution output runs once per number; wire a **Print** there.',
      'Print the loop variable, not a fixed value.',
    ],
    hints: [
      'The range end is exclusive, which is why 11 gets you 10.',
      'The loop\'s current value comes out of a port on the loop node itself.',
    ],
    expect: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    start: (ctx) => blankStart(ctx, 'count-to-ten'),
  },

  {
    id: 'calculator',
    title: 'A calculator',
    difficulty: 'medium',
    brief:
      'Read three command-line arguments — a number, an operator, and another number — and print the result. The checker runs it with `12 * 4`.',
    steps: [
      'Get the arguments with **Command Line Args**, then pull out items 0, 1 and 2 with **Get At**.',
      'Convert the two numbers from text with a **To Number** conversion node.',
      'Branch on the operator with **If** nodes, or a **Select**, and do the matching **Arithmetic**.',
      'Print the result.',
    ],
    hints: [
      'Arguments arrive as strings. Arithmetic on a string will not type-check — that is the type system doing its job.',
      'Chain If nodes: if the operator is "+" do one thing, else check "-", and so on.',
      'Handle at least `+`, `-`, `*` and `/` if you want it to be a real calculator.',
    ],
    grants: ['stdio', 'env'],
    args: ['12', '*', '4'],
    expect: ['48'],
    afterword:
      'The interesting part is that nothing you drew mentioned a language. The same graph compiles to Python, Go, Rust or Java.',
    start: (ctx) => blankStart(ctx, 'calculator', ['stdio', 'env']),
  },

  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    difficulty: 'medium',
    brief:
      'For 1 to 15: print "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for both, otherwise the number.',
    steps: [
      'Loop from 1 to 16 with **For Range**.',
      'Test divisibility with `%` and **Compare**.',
      'Order the conditions so that "FizzBuzz" is checked before "Fizz" and "Buzz".',
    ],
    hints: [
      'Check the both-case first, or 15 prints "Fizz" and stops.',
      'A **Logic** node with `&&` combines the two conditions.',
    ],
    expect: ['1', '2', 'fizz', '4', 'buzz', 'fizz', '7', '8', 'fizz', 'buzz', '11', 'fizz', '13', '14', 'fizzbuzz'],
    start: (ctx) => blankStart(ctx, 'fizzbuzz'),
  },

  {
    id: 'reverse-words',
    title: 'Reverse the words',
    difficulty: 'medium',
    brief: 'Take the sentence "the quick brown fox" and print its words in reverse order, space separated.',
    steps: [
      'Split the sentence on a space with a **Split** node.',
      'Reverse the resulting list.',
      'Join it back together with a space and print it.',
    ],
    hints: [
      'Split, Reverse and Join are all in the String and List categories.',
      'Joining a list of strings is one node — you do not need a loop.',
    ],
    expect: ['fox brown quick the'],
    start: (ctx) => blankStart(ctx, 'reverse-words'),
  },

  {
    id: 'number-stats',
    title: 'Number statistics',
    difficulty: 'hard',
    brief:
      'From the list 8, 3, 9, 1, 5: print the smallest, the largest, the total, and the list sorted ascending — each on its own line, labelled.',
    steps: [
      'Build the list with a **List Literal**.',
      'Use the Min, Max, Sum and Sort nodes.',
      'Label each line, for example `min: 1`.',
    ],
    hints: [
      'Min and Max return an optional value, because an empty list has neither.',
      'A **Format** node builds the labelled line in one step.',
    ],
    expect: ['min: 1', 'max: 9', 'sum: 26', '1 3 5 8 9'],
    afterword:
      'Those list operations are the functional and pipeline paradigms in miniature. They lower to comprehensions in Python, streams in Java, and iterator adaptors in Rust.',
    start: (ctx) => blankStart(ctx, 'number-stats'),
  },

  {
    id: 'two-files',
    title: 'Split it across two files',
    difficulty: 'hard',
    brief:
      'Move a calculation into its own file and call it from the entry point. Print the result of doubling 21.',
    steps: [
      'Use **New file** to add a second source file.',
      'In that file, add a **Function** node named `double` taking one number and returning it multiplied by two.',
      'Back in the entry file, add a **Call Function** node and pick `double` from the list.',
      'Generate, then open the **Architecture** view — the import edge is drawn for you.',
    ],
    hints: [
      'The Call Function picker only lists functions that exist; if yours is missing, check the Function node has a name.',
      'You never write the import. Generation works out which file the symbol lives in.',
    ],
    expect: ['42'],
    afterword:
      'Renaming that file now costs nothing: references are file ids, and the import text is recomputed on the next generate.',
    start: (ctx) => blankStart(ctx, 'two-files'),
  },
];

// ---------------------------------------------------------------------------

const ORDER: Record<Difficulty, number> = { tutorial: 0, easy: 1, medium: 2, hard: 3 };

/** Challenges a language can actually express, easiest first. */
export function challengesFor(features: LanguageFeatures | undefined): Challenge[] {
  return CHALLENGES.filter((c) => !c.needs || !features || c.needs.every((f) => features[f] !== false)).sort(
    (a, b) => ORDER[a.difficulty] - ORDER[b.difficulty],
  );
}

export function getChallenge(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

/** The challenge a project was started from, if any. */
export function challengeOf(project: Project): Challenge | undefined {
  const prefix = 'challenge/';
  return project.template?.startsWith(prefix) ? getChallenge(project.template.slice(prefix.length)) : undefined;
}

export interface CheckResult {
  passed: boolean;
  /** Every expectation, in order, with whether it was found. */
  checks: { expected: string; found: boolean }[];
  message: string;
}

/**
 * Checks a program's output against a challenge.
 *
 * Expectations must appear in order but need not be adjacent, and matching
 * ignores case and collapses whitespace. That is deliberate: `[1, 2, 3]`,
 * `[1 2 3]` and `1,2,3` are the same answer spelled by three languages, and
 * failing someone for their backend's list formatting would teach nothing.
 */
export function checkOutput(challenge: Challenge, stdout: string): CheckResult {
  const haystack = normalise(stdout);
  const checks: CheckResult['checks'] = [];
  let cursor = 0;

  for (const expected of challenge.expect) {
    const needle = normalise(expected);
    const at = haystack.indexOf(needle, cursor);
    const found = at >= 0;
    if (found) cursor = at + needle.length;
    checks.push({ expected, found });
  }

  const missing = checks.filter((c) => !c.found);
  if (!missing.length) {
    return { passed: true, checks, message: 'All checks passed.' };
  }
  const first = missing[0]!;
  return {
    passed: false,
    checks,
    message:
      missing.length === checks.length
        ? `Expected the output to contain "${first.expected}".`
        : `Missing ${missing.length} of ${checks.length}: the first not found in order was "${first.expected}".`,
  };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[[\],]/g, ' ')
    .replace(/(\d)\.0\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
