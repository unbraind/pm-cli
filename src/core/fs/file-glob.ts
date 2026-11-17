/**
 * @module core/fs/file-glob
 *
 * Bounded file glob expansion for linked-artifact `--add-glob` (pm-gh1748).
 *
 * The pattern compiles to a Thompson NFA, and the directory walk advances a
 * lazily built DFA one path character at a time. Matching therefore never
 * backtracks: time is linear in the walked path text for every pattern, and a
 * directory whose path can no longer match is never read. This replaces the
 * runtime tinyglobby/fdir/picomatch graph, whose extglob compiler is subject to
 * GHSA-fc5q-39xc-vjpf.
 *
 * Grammar (docs/SDK.md "Linked-artifact globs"): `*`, `?`, `**` as a whole
 * segment, bracket expressions with ranges, `!`/`^` negation and POSIX classes
 * (each also matches its own literal text, so `app/[slug]/*` reaches a
 * `[slug]` directory), `{a,b}` alternation, `{1..3}` and `{a..c}` ranges, the
 * `@(…)`, `?(…)`, `*(…)` and `+(…)` extglobs, and backslash escapes. Every
 * pattern matches dot files. Negation, as a leading `!` or `!(…)`, is refused.
 */
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/** Longest accepted pattern, in code points; longer patterns match nothing. */
const MAX_PATTERN_LENGTH = 4096;
/** Deepest accepted nesting of braces and extglobs; deeper patterns match nothing. */
const MAX_NESTING = 32;
/** Largest accepted `{a..b}` range. */
const MAX_RANGE_SIZE = 1000;
/** Largest accepted NFA; larger patterns match nothing. */
const MAX_STATES = 50_000;
/**
 * What the lazily built DFA may retain before it drops its cache: interned
 * nodes, cached transitions and the NFA state ids those nodes hold. Nodes a
 * walk still holds stay valid after a reset; they are simply no longer cached.
 */
interface DfaLimits {
  nodes: number;
  edges: number;
  stateIds: number;
}
const DFA_LIMITS: DfaLimits = { nodes: 10_000, edges: 40_000, stateIds: 2_000_000 };
const SLASH = 0x2f;

type Node =
  | { kind: "char"; value: number }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "segments" }
  | { kind: "rest" }
  | { kind: "class"; negated: boolean; ranges: Array<[number, number]>; literal: number[] }
  | { kind: "alt"; options: Node[][] }
  | { kind: "repeat"; optional: boolean; many: boolean; options: Node[][] };

type EdgeTest =
  | { kind: "char"; value: number }
  | { kind: "any" }
  | { kind: "all" }
  | { kind: "class"; negated: boolean; ranges: Array<[number, number]> };

interface State {
  epsilon: number[];
  edges: Array<{ test: EdgeTest; to: number }>;
}

/** Raised when a pattern exceeds a declared bound; the expansion then matches nothing. */
class GlobTooComplex extends Error {}

/** POSIX bracket classes; a Map, so names such as `constructor` are unknown rather than inherited. */
const POSIX_CLASSES: ReadonlyMap<string, Array<[number, number]>> = new Map(Object.entries({
  alnum: [[48, 57], [65, 90], [97, 122]],
  alpha: [[65, 90], [97, 122]],
  ascii: [[0, 127]],
  blank: [[9, 9], [32, 32]],
  cntrl: [[0, 31], [127, 127]],
  digit: [[48, 57]],
  graph: [[33, 126]],
  lower: [[97, 122]],
  print: [[32, 126]],
  punct: [[33, 47], [58, 64], [91, 96], [123, 126]],
  space: [[9, 13], [32, 32]],
  upper: [[65, 90]],
  word: [[48, 57], [65, 90], [95, 95], [97, 122]],
  xdigit: [[48, 57], [65, 70], [97, 102]],
} satisfies Record<string, Array<[number, number]>>));

/** Refuse negation, which a linked-artifact list cannot express as a set of added files. */
function negationRefusal(): PmCliError {
  return new PmCliError(
    "--add-glob does not support negated patterns (a leading ! or !(...)); list the files or patterns to link instead",
    EXIT_CODE.USAGE,
  );
}

/** Return the index just past a bracket expression opened at `start`, or -1 when it never closes. */
function bracketEnd(chars: string[], start: number): number {
  let index = start + 1;
  if (chars[index] === "!" || chars[index] === "^") index += 1;
  if (chars[index] === "]") index += 1;
  while (index < chars.length) {
    const char = chars[index]!;
    if (char === "\\") index += 2;
    else if (char === "[" && chars[index + 1] === ":") {
      const close = chars.indexOf(":", index + 2);
      if (close === -1 || chars[close + 1] !== "]") index += 1;
      else index = close + 2;
    } else if (char === "]") return index + 1;
    else index += 1;
  }
  return -1;
}

interface Opener {
  index: number;
  kind: "{" | "(";
}

/** Return the construct a character opens at `index`: a brace, or an extglob whose operator precedes `(`. */
function openerAt(chars: string[], index: number): Opener | undefined {
  const char = chars[index];
  if (char === "{") return { index, kind: "{" };
  const operator = chars[index - 1];
  if (char === "(" && operator !== undefined && "@?*+!".includes(operator) && !isEscaped(chars, index - 1)) {
    return { index: index - 1, kind: "(" };
  }
  return undefined;
}

/** Close the innermost opener when the character at `index` closes its kind, refusing a closed negation. */
function closeAt(chars: string[], index: number, open: Opener[], closers: Map<number, number>): void {
  const char = chars[index];
  const kind = char === "}" ? "{" : char === ")" ? "(" : undefined;
  if (kind === undefined || open.at(-1)?.kind !== kind) return;
  const opener = open.pop()!;
  closers.set(opener.index, index);
  if (chars[opener.index] === "!") throw negationRefusal();
}

/**
 * Pair every brace and extglob opener with its closer in one linear pass, so
 * the parser never retries an unclosed construct. Unpaired characters stay
 * literal; an unescaped `!(…)` that closes is negation and is refused.
 */
function pairConstructs(chars: string[]): { closers: Map<number, number>; brackets: Map<number, number> } {
  const closers = new Map<number, number>();
  const brackets = new Map<number, number>();
  const open: Opener[] = [];
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === "\\") { index += 2; continue; }
    const end = chars[index] === "[" ? bracketEnd(chars, index) : -1;
    if (end !== -1) { brackets.set(index, end); index = end; continue; }
    const opener = openerAt(chars, index);
    if (opener !== undefined) open.push(opener);
    else closeAt(chars, index, open, closers);
    if (open.length > MAX_NESTING) throw new GlobTooComplex();
    index += 1;
  }
  return { closers, brackets };
}

/** Return whether the character at `index` is preceded by an odd run of backslashes. */
function isEscaped(chars: ArrayLike<string>, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && chars[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

/** Spell a literal character run as char nodes. */
function literalNodes(text: string): Node[] {
  return Array.from(text, (char) => ({ kind: "char", value: char.codePointAt(0)! }) as Node);
}

/** Expand `{a..b}` integer or single-letter ranges; anything else is not a range. */
function braceRange(content: string): string[] | undefined {
  const numeric = /^(-?(?:0|[1-9]\d{0,8}))\.\.(-?(?:0|[1-9]\d{0,8}))$/u.exec(content);
  const alphabetic = /^([A-Za-z])\.\.([A-Za-z])$/u.exec(content);
  if (numeric === null && alphabetic === null) return undefined;
  const [from, to] = numeric !== null
    ? [Number(numeric[1]), Number(numeric[2])]
    : [alphabetic![1]!.codePointAt(0)!, alphabetic![2]!.codePointAt(0)!];
  if (Math.abs(to - from) + 1 > MAX_RANGE_SIZE) throw new GlobTooComplex();
  const step = from <= to ? 1 : -1;
  const values: string[] = [];
  for (let value = from; value !== to + step; value += step) {
    values.push(numeric !== null ? String(value) : String.fromCodePoint(value));
  }
  return values;
}

/** Read a POSIX class `[:name:]` at `index`; bracketEnd skipped the same span, so it ends before the closer. */
function posixClassAt(chars: string[], index: number): { ranges: Array<[number, number]>; next: number } | undefined {
  if (chars[index] !== "[" || chars[index + 1] !== ":") return undefined;
  const colon = chars.indexOf(":", index + 2);
  if (colon === -1 || chars[colon + 1] !== "]") return undefined;
  return { ranges: POSIX_CLASSES.get(chars.slice(index + 2, colon).join("")) ?? [], next: colon + 2 };
}

/** Read one bracket member at `index`, resolving an escape that is not the closer itself. */
function memberAt(chars: string[], index: number, close: number): { codePoint: number; next: number } {
  const escaped = chars[index] === "\\" && index + 1 < close;
  return { codePoint: chars[escaped ? index + 1 : index]!.codePointAt(0)!, next: index + (escaped ? 2 : 1) };
}

/** The bracket text as written, with escapes resolved, which the expression also matches literally. */
function bracketLiteral(chars: string[], start: number, end: number): number[] {
  const literal: number[] = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    if (chars[cursor] === "\\" && cursor + 1 < end) cursor += 1;
    literal.push(chars[cursor]!.codePointAt(0)!);
  }
  return literal;
}

/**
 * Parse a bracket expression into code-point ranges. bracketEnd already chose
 * the closing "]", so any "]" before it is a member.
 */
function parseClass(chars: string[], start: number, end: number): Node {
  let index = start + 1;
  const negated = chars[index] === "!" || chars[index] === "^";
  if (negated) index += 1;
  const ranges: Array<[number, number]> = [];
  const close = end - 1;
  while (index < close) {
    const posix = posixClassAt(chars, index);
    if (posix !== undefined) {
      ranges.push(...posix.ranges);
      index = posix.next;
      continue;
    }
    const low = memberAt(chars, index, close);
    index = low.next;
    if (chars[index] !== "-" || index + 1 >= close) {
      ranges.push([low.codePoint, low.codePoint]);
      continue;
    }
    const high = memberAt(chars, index + 1, close);
    index = high.next;
    if (low.codePoint <= high.codePoint) ranges.push([low.codePoint, high.codePoint]);
  }
  return { kind: "class", negated, ranges, literal: bracketLiteral(chars, start, end) };
}

interface Token {
  nodes: Node[];
  next: number;
  segmentStart: boolean;
}

/** Recursive-descent parser over pre-paired constructs; recursion depth is bounded by MAX_NESTING. */
class Parser {
  private readonly chars: string[];
  private readonly closers: Map<number, number>;
  private readonly brackets: Map<number, number>;

  constructor(chars: string[], closers: Map<number, number>, brackets: Map<number, number>) {
    this.chars = chars;
    this.closers = closers;
    this.brackets = brackets;
  }

  /** Parse `[start, end)` into alternatives split at top-level `separator` characters. */
  alternatives(start: number, end: number, separator: string | undefined, segmentStart: boolean): Node[][] {
    const options: Node[][] = [];
    let cursor = start;
    for (;;) {
      const { nodes, stop } = this.sequence(cursor, end, separator, segmentStart);
      options.push(nodes);
      if (stop >= end) return options;
      cursor = stop + 1;
    }
  }

  /** Parse one sequence until `end` or an unnested `separator`, returning where it stopped. */
  sequence(start: number, end: number, separator: string | undefined, segmentStart: boolean): { nodes: Node[]; stop: number } {
    const nodes: Node[] = [];
    let index = start;
    let atSegmentStart = segmentStart;
    while (index < end) {
      if (this.chars[index] === separator) return { nodes, stop: index };
      const token = this.token(index, end, separator, atSegmentStart);
      nodes.push(...token.nodes);
      index = token.next;
      atSegmentStart = token.segmentStart;
    }
    return { nodes, stop: end };
  }

  /** Parse the token at `index`. */
  private token(index: number, end: number, separator: string | undefined, segmentStart: boolean): Token {
    const char = this.chars[index]!;
    if (char === "\\") {
      return { nodes: literalNodes(index + 1 < end ? this.chars[index + 1]! : "\\"), next: index + 2, segmentStart: false };
    }
    if (char === "/") return { nodes: [{ kind: "char", value: SLASH }], next: index + 1, segmentStart: true };
    const closer = this.closers.get(index);
    if (closer !== undefined) {
      return char === "{" ? this.brace(index, closer, segmentStart) : this.extglob(char, index, closer, segmentStart);
    }
    const bracket = this.brackets.get(index);
    if (bracket !== undefined) return { nodes: [parseClass(this.chars, index, bracket)], next: bracket, segmentStart: false };
    if (char === "*") return this.stars(index, end, separator, segmentStart);
    return { nodes: char === "?" ? [{ kind: "any" }] : literalNodes(char), next: index + 1, segmentStart: false };
  }

  /** Parse an extglob whose operator is at `index` and whose ")" is at `closer`; a globstar alternative at a segment start stays a globstar. */
  private extglob(operator: string, index: number, closer: number, segmentStart: boolean): Token {
    const options = this.alternatives(index + 2, closer, "|", segmentStart);
    const node: Node = operator === "@"
      ? { kind: "alt", options }
      : { kind: "repeat", optional: operator !== "+", many: operator !== "?", options };
    return { nodes: [node], next: closer + 1, segmentStart: false };
  }

  /** Parse a paired brace: alternation, a range, or (with one part) literal braces around a pattern. */
  private brace(index: number, closer: number, segmentStart: boolean): Token {
    const options = this.alternatives(index + 1, closer, ",", segmentStart);
    const next = closer + 1;
    if (options.length > 1) return { nodes: [{ kind: "alt", options }], next, segmentStart: false };
    const range = braceRange(this.chars.slice(index + 1, closer).join(""));
    if (range !== undefined) return { nodes: [{ kind: "alt", options: range.map(literalNodes) }], next, segmentStart: false };
    return { nodes: [...literalNodes("{"), ...options[0]!, ...literalNodes("}")], next, segmentStart: false };
  }

  /** Parse a run of stars: exactly two at a segment start are a globstar, anything else one star. */
  private stars(index: number, end: number, separator: string | undefined, segmentStart: boolean): Token {
    let run = 1;
    while (this.chars[index + run] === "*" && index + run < end && !this.closers.has(index + run)) run += 1;
    const after = index + run < end ? this.chars[index + run] : undefined;
    const globstar = run === 2 && segmentStart;
    if (globstar && after === "/") return { nodes: [{ kind: "segments" }], next: index + run + 1, segmentStart: true };
    // A trailing globstar spans directories at the top level and in a brace
    // alternative; one that ends an extglob alternative is a single star.
    const rest = globstar && separator !== "|" && (after === undefined || after === separator);
    return { nodes: [rest ? { kind: "rest" } : { kind: "star" }], next: index + run, segmentStart: false };
  }
}

/** Thompson construction with a hard state bound. */
class Nfa {
  readonly states: State[] = [];

  /** Allocate one state, refusing patterns past MAX_STATES. */
  add(): number {
    if (this.states.length >= MAX_STATES) throw new GlobTooComplex();
    this.states.push({ epsilon: [], edges: [] });
    return this.states.length - 1;
  }

  /** Add a consuming edge from `from` to a new state and return it. */
  private edge(from: number, test: EdgeTest): number {
    const to = this.add();
    this.states[from]!.edges.push({ test, to });
    return to;
  }

  /** Build `options` as an alternation starting at `from` and return the shared end state. */
  private alternation(from: number, options: Node[][]): number {
    const end = this.add();
    for (const option of options) {
      const start = this.add();
      this.states[from]!.epsilon.push(start);
      this.states[this.build(option, start)]!.epsilon.push(end);
    }
    return end;
  }

  /** Build `nodes` from state `from` and return the final state. */
  build(nodes: Node[], from: number): number {
    let current = from;
    for (const node of nodes) current = this.node(node, current);
    return current;
  }

  /** Build one node from state `from` and return its end state. */
  private node(node: Node, from: number): number {
    switch (node.kind) {
      case "char":
        return this.edge(from, { kind: "char", value: node.value });
      case "any":
        return this.edge(from, { kind: "any" });
      case "star": {
        const loop = this.add();
        this.states[from]!.epsilon.push(loop);
        this.states[loop]!.edges.push({ test: { kind: "any" }, to: loop });
        return loop;
      }
      case "segments": {
        // Zero or more whole segments, each any non-separator text and a "/".
        const between = this.add();
        this.states[from]!.epsilon.push(between);
        const inside = this.edge(between, { kind: "any" });
        this.states[inside]!.edges.push({ test: { kind: "any" }, to: inside });
        this.states[inside]!.edges.push({ test: { kind: "char", value: SLASH }, to: between });
        return between;
      }
      case "rest": {
        const loop = this.add();
        this.states[from]!.epsilon.push(loop);
        this.states[loop]!.edges.push({ test: { kind: "all" }, to: loop });
        return loop;
      }
      case "class": {
        const end = this.add();
        const classEnd = this.edge(from, { kind: "class", negated: node.negated, ranges: node.ranges });
        this.states[classEnd]!.epsilon.push(end);
        this.states[this.build(node.literal.map((value) => ({ kind: "char", value }) as Node), from)]!.epsilon.push(end);
        return end;
      }
      case "alt":
        return this.alternation(from, node.options);
      case "repeat": {
        const first = node.optional ? from : this.alternation(from, node.options);
        const end = this.add();
        this.states[first]!.epsilon.push(end);
        if (node.many) {
          const again = this.alternation(end, node.options);
          this.states[again]!.epsilon.push(end);
        } else {
          this.states[this.alternation(first, node.options)]!.epsilon.push(end);
        }
        return end;
      }
    }
  }
}

/** Return whether one code point satisfies an NFA edge. */
function accepts(test: EdgeTest, codePoint: number): boolean {
  switch (test.kind) {
    case "char":
      return test.value === codePoint;
    case "any":
      return codePoint !== SLASH;
    case "all":
      return true;
    case "class":
      return codePoint !== SLASH &&
        test.ranges.some(([low, high]) => codePoint >= low && codePoint <= high) !== test.negated;
  }
}

interface DfaNode {
  /** Identity within its generation; transitions are cached by (id, code point). */
  id: number;
  generation: number;
  states: number[];
  accepting: boolean;
}

/**
 * Lazily determinized matcher; each DFA node is one epsilon-closed NFA state
 * set. Nodes and transitions live in generation-scoped tables, so a reset
 * releases everything the matcher retains, not only its index.
 */
class PathMatcher {
  private generation = 0;
  private nextId = 0;
  private nodes = new Map<string, DfaNode>();
  private edges = new Map<string, DfaNode>();
  private stateIds = 0;
  private readonly nfa: Nfa;
  private readonly acceptState: number;
  private readonly limits: DfaLimits;
  readonly start: DfaNode;

  constructor(nfa: Nfa, startState: number, acceptState: number, limits: DfaLimits) {
    this.nfa = nfa;
    this.acceptState = acceptState;
    this.limits = limits;
    this.start = this.node(this.closure([startState]));
  }

  /** Report what the matcher currently retains. */
  retained(): { nodes: number; edges: number; stateIds: number } {
    return { nodes: this.nodes.size, edges: this.edges.size, stateIds: this.stateIds };
  }

  /** Drop every cached node and transition and start a new generation. */
  private reset(): void {
    this.generation += 1;
    this.nodes = new Map();
    this.edges = new Map();
    this.stateIds = 0;
  }

  /** Close a state set over epsilon edges, iteratively. */
  private closure(seed: number[]): number[] {
    const seen = new Set<number>(seed);
    const stack = [...seed];
    while (stack.length > 0) {
      for (const next of this.nfa.states[stack.pop()!]!.epsilon) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    return [...seen].sort((left, right) => left - right);
  }

  /** Intern a closed state set, resetting first when it would exceed a retention bound. */
  private node(states: number[]): DfaNode {
    const key = states.join(",");
    const cached = this.nodes.get(key);
    if (cached !== undefined) return cached;
    if (this.nodes.size >= this.limits.nodes || this.stateIds + states.length > this.limits.stateIds) this.reset();
    const created: DfaNode = { id: this.nextId, generation: this.generation, states, accepting: states.includes(this.acceptState) };
    this.nextId += 1;
    this.nodes.set(key, created);
    this.stateIds += states.length;
    return created;
  }

  /** Advance one code point, caching the transition only while `from` belongs to the current generation. */
  step(from: DfaNode, codePoint: number): DfaNode {
    const key = `${from.id}:${codePoint}`;
    const known = from.generation === this.generation ? this.edges.get(key) : undefined;
    if (known !== undefined) return known;
    const reached: number[] = [];
    for (const state of from.states) {
      for (const { test, to } of this.nfa.states[state]!.edges) {
        if (accepts(test, codePoint)) reached.push(to);
      }
    }
    const next = this.node(this.closure(reached));
    if (this.edges.size >= this.limits.edges) this.reset();
    if (from.generation === this.generation) this.edges.set(key, next);
    return next;
  }

  /** Advance over a whole path component. */
  advance(from: DfaNode, text: string): DfaNode {
    let node = from;
    for (const char of text) {
      if (node.states.length === 0) return node;
      node = this.step(node, char.codePointAt(0)!);
    }
    return node;
  }
}

/** Compile a pattern remainder (relative to the walk root) into a matcher. */
function compile(text: string, limits: DfaLimits = DFA_LIMITS): PathMatcher {
  const chars = Array.from(text);
  const { closers, brackets } = pairConstructs(chars);
  const nodes = new Parser(chars, closers, brackets).sequence(0, chars.length, undefined, true).nodes;
  const nfa = new Nfa();
  const start = nfa.add();
  const accept = nfa.build(nodes, start);
  return new PathMatcher(nfa, start, accept, limits);
}

/** Return whether a path segment can be resolved as literal text without matching. */
function isStaticSegment(segment: string): boolean {
  return !/[*?[\]{}()!@+\\]/u.test(segment);
}

type EntryKind = "file" | "directory" | "other";

/** Classify a file system entry by the object it names. */
function kindOf(entry: { isFile(): boolean; isDirectory(): boolean }): EntryKind {
  return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
}

/**
 * Resolve a directory entry to its kind and real path, following symbolic
 * links. A dangling or unreadable link resolves to nothing, like an absent
 * entry.
 */
async function resolveEntry(directory: string, real: string, entry: Dirent): Promise<{ kind: EntryKind; real: string } | undefined> {
  if (!entry.isSymbolicLink()) return { kind: kindOf(entry), real: path.join(real, entry.name) };
  try {
    const target = await realpath(path.join(directory, entry.name));
    return { kind: kindOf(await stat(target)), real: target };
  } catch {
    return undefined;
  }
}

/**
 * Walk one directory, pruning every entry whose path can no longer match. A
 * symbolic link to a directory is followed unless it resolves to a directory
 * already on the current walk path, so link cycles terminate.
 */
async function walk(
  matcher: PathMatcher,
  directory: string,
  real: string,
  prefix: string,
  node: DfaNode,
  ancestors: Set<string>,
  out: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const afterName = matcher.advance(node, entry.name);
    if (afterName.states.length === 0) continue;
    const resolved = await resolveEntry(directory, real, entry);
    if (resolved === undefined) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (resolved.kind === "file" && afterName.accepting) out.push(relative);
    if (resolved.kind !== "directory") continue;
    const afterSlash = matcher.step(afterName, SLASH);
    if (afterSlash.states.length === 0 || ancestors.has(resolved.real)) continue;
    ancestors.add(resolved.real);
    await walk(matcher, path.join(directory, entry.name), resolved.real, relative, afterSlash, ancestors, out);
    ancestors.delete(resolved.real);
  }
}

/** Strip unescaped trailing separators; a lone "/" stays. */
function trimTrailingSeparators(pattern: string): string {
  let text = pattern;
  while (text.length > 1 && text.endsWith("/") && !isEscaped(text, text.length - 1)) text = text.slice(0, -1);
  return text;
}

/** Resolve a pattern without glob syntax as a literal path; only an existing file matches. */
async function literalMatch(text: string, cwd: string): Promise<string[]> {
  const target = path.resolve(cwd, text);
  const found = await stat(target).catch(() => undefined);
  if (found === undefined || !found.isFile()) return [];
  return [path.isAbsolute(text) ? target.replaceAll("\\", "/") : path.posix.normalize(text)];
}

/** Split the leading literal segments off a pattern: the walk root, its output base and the remainder. */
function splitStatic(text: string, cwd: string): { root: string; base: string; rest: string } | undefined {
  const segments = text.split("/");
  let count = 0;
  while (count < segments.length && isStaticSegment(segments[count]!)) count += 1;
  if (count === segments.length) return undefined;
  const prefix = count === 0 ? "" : `${segments.slice(0, count).join("/")}/`;
  const root = path.resolve(cwd, prefix);
  if (path.isAbsolute(text)) return { root, base: root.replaceAll("\\", "/"), rest: segments.slice(count).join("/") };
  const relative = path.posix.normalize(prefix === "" ? "." : prefix).replace(/\/$/u, "");
  return { root, base: relative === "." ? "" : relative, rest: segments.slice(count).join("/") };
}

/** Compile a remainder, or return nothing when it exceeds a declared bound. */
function compileWithinBounds(text: string): PathMatcher | undefined {
  try {
    return compile(text);
  } catch (error) {
    if (error instanceof GlobTooComplex) return undefined;
    throw error;
  }
}

/**
 * Expand a file glob from `cwd`. The pattern is first normalized lexically
 * (`a/./b`, `a/x/../b` and `a//b` become `a/b`, as before). Relative patterns return `/`-separated paths
 * relative to `cwd` (a leading `../` is kept), absolute patterns return
 * absolute paths. Only files are returned, symbolic links are followed and a
 * literal directory never expands. A pattern past a declared bound matches
 * nothing; negation is refused with a usage error.
 */
export async function expandFileGlob(pattern: string, cwd: string): Promise<string[]> {
  if (pattern.startsWith("!")) throw negationRefusal();
  if (Array.from(pattern).length > MAX_PATTERN_LENGTH) return [];
  // Normalize "./", "../" and repeated separators lexically, as the previous expansion did.
  const text = trimTrailingSeparators(path.posix.normalize(pattern));
  const parts = splitStatic(text, cwd);
  if (parts === undefined) return literalMatch(text, cwd);
  const matcher = compileWithinBounds(parts.rest);
  if (matcher === undefined) return [];
  const real = await realpath(parts.root).catch(() => undefined);
  if (real === undefined) return [];
  const out: string[] = [];
  await walk(matcher, parts.root, real, "", matcher.start, new Set([real]), out);
  return out.map((relative) => path.posix.join(parts.base, relative));
}

/** Internal hooks for bound and cache tests; not part of any public surface. */
export const _testOnly = { compile };
