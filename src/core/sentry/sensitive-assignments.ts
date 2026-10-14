/**
 * @module core/sentry/sensitive-assignments
 *
 * Redacts sensitive values in fragmented and serialized diagnostic text.
 */
/** Shared sensitive-key vocabulary for structured data and diagnostic text. */
export const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|credentials|bearer|dsn)/i;

const INLINE_SENSITIVE_ASSIGNMENT_RE = new RegExp(
  `(?:\\b|(?<=_))(${SENSITIVE_KEY_PATTERN.source})\\s*[:=]\\s*([^\\s,;]+)`,
  "giu",
);

interface SensitiveAssignment {
  index: number;
  start: number;
  unquotedEnd: number;
  replacement: string;
}

interface DelimiterToken {
  index: number;
  end: number;
  identity: string;
  character: string;
  width: number;
}

/** Read one delimiter without retrying every suffix of a backslash run. */
function readDelimiterToken(value: string, index: number, token: string): DelimiterToken | undefined {
  let start = index;
  while (start > 0 && value[start - 1] === "\\") start--;
  const unicode = token.length > 1;
  if (unicode && start === index) return undefined;
  let remaining = unicode ? (index - start) * 2 : index - start + 1;
  let width = 1;
  while (remaining % 2 === 0) {
    width *= 2;
    remaining /= 2;
  }
  const character = unicode ? String.fromCharCode(Number.parseInt(token.slice(1), 16)) : token;
  return { index: start, end: index + token.length, identity: `${character}:${width}`, character, width };
}

/** Consume one quoted value, respecting the escaping level of serialized JSON text. */
function quotedValueEnd(value: string, delimiter: DelimiterToken): number {
  const tokens = /["']|u(?:0022|0027)/gi;
  tokens.lastIndex = delimiter.end;
  for (const token of value.matchAll(tokens)) {
    const quote = readDelimiterToken(value, token.index, token[0]);
    if (quote?.identity === delimiter.identity) return quote.end;
  }
  return value.length;
}

/** Finish a balanced container or redact the remaining input on a mismatched close. */
function closeSensitiveContainer(stack: Array<{ character: string; width: number }>, current: DelimiterToken, end: number, inputEnd: number): number | undefined {
  const expected = stack.pop()!;
  if (expected.character !== current.character || expected.width !== current.width) return inputEnd;
  return stack.length === 0 ? end : undefined;
}

/** Consume a whole sensitive container; malformed or incomplete input fails closed. */
function containerValueEnd(value: string, opener: DelimiterToken): number {
  const stack = [{ character: opener.character === "{" ? "}" : "]", width: opener.width }];
  const tokens = /["'{}[\]]|u(?:0022|0027|007b|007d|005b|005d)/gi;
  tokens.lastIndex = opener.end;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(value)) !== null) {
    const delimiter = readDelimiterToken(value, token.index, token[0]);
    if (!delimiter) continue;
    const current = delimiter.character;
    if (current === "{" || current === "[") {
      stack.push({ character: current === "{" ? "}" : "]", width: delimiter.width });
      continue;
    }
    if (current === "}" || current === "]") {
      const end = closeSensitiveContainer(stack, delimiter, delimiter.end, value.length);
      if (end !== undefined) return end;
      continue;
    }
    tokens.lastIndex = quotedValueEnd(value, delimiter);
  }
  return value.length;
}

/** Locate the end of a scalar, quoted string, or nested sensitive value. */
function sensitiveAssignmentEnd(value: string, start: number, unquotedEnd: number): number {
  const match = /^(\\*)(["'{[]|u(?:0022|0027|007b|005b))/i.exec(value.slice(start));
  const delimiter = match ? readDelimiterToken(value, start + match[1]!.length, match[2]!) : undefined;
  if (delimiter?.character === "{" || delimiter?.character === "[") return containerValueEnd(value, delimiter);
  if (delimiter) return quotedValueEnd(value, delimiter);
  return unquotedEnd;
}

/** Decode escaped key characters in one pass, leaving ordinary key bytes intact. */
function decodeAssignmentKey(value: string): string {
  const chunks: string[] = [];
  let consumed = 0;
  for (const token of value.matchAll(/u([\da-f]{4})/gi)) {
    let start = token.index;
    while (start > consumed && value[start - 1] === "\\") start--;
    if (start === token.index) continue;
    chunks.push(value.slice(consumed, start), String.fromCharCode(Number.parseInt(token[1]!, 16)));
    consumed = token.index + token[0].length;
  }
  chunks.push(value.slice(consumed));
  return chunks.join("");
}

const ENCODED_DIAGNOSTIC_WHITESPACE = "(?:\\s|\\\\+u(?:0009|000a|000d|0020))*";
const QUOTED_ASSIGNMENT_SEPARATOR_RE = new RegExp(
  "^" + ENCODED_DIAGNOSTIC_WHITESPACE + "(?::|=|\\\\+u(?:003a|003d))" + ENCODED_DIAGNOSTIC_WHITESPACE, "iu",
);

/** Fail closed when a sensitive key has an opaque encoded separator. */
function quotedAssignment(value: string, rawKey: string, after: number): SensitiveAssignment | undefined {
  const key = decodeAssignmentKey(rawKey);
  if (!SENSITIVE_KEY_PATTERN.test(key) && !/\\u/iu.test(key)) return undefined;
  const suffix = value.slice(after);
  const separator = QUOTED_ASSIGNMENT_SEPARATOR_RE.exec(suffix);
  if (!separator) {
    return /^\s*\\+u/iu.test(suffix)
      ? { index: after, start: after, unquotedEnd: value.length, replacement: "[scrubbed]" }
      : undefined;
  }
  const start = after + separator[0].length;
  const scalar = /^[^\s,;]+/u.exec(value.slice(start));
  return scalar ? { index: start, start, unquotedEnd: start + scalar[0].length, replacement: "[scrubbed]" } : undefined;
}

/** Recognize quoted keys without requiring complete JSON or decoding safe diagnostic text. */
function quotedSensitiveAssignments(value: string): SensitiveAssignment[] {
  const previousQuotes = new Map<string, number>();
  const assignments: SensitiveAssignment[] = [];
  for (const token of value.matchAll(/["']|u(?:0022|0027)/gi)) {
    const quote = readDelimiterToken(value, token.index, token[0]);
    if (!quote) continue;
    const previous = previousQuotes.get(quote.identity);
    const after = quote.end;
    previousQuotes.set(quote.identity, after);
    if (previous === undefined) continue;
    const assignment = quotedAssignment(value, value.slice(previous, quote.index), after);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}

/** Redact complete sensitive values while preserving every byte of safe diagnostic text. */
export function scrubInlineSensitiveAssignments(value: string): string {
  const assignments = quotedSensitiveAssignments(value);
  for (const match of value.matchAll(INLINE_SENSITIVE_ASSIGNMENT_RE)) {
    const unquotedEnd = match.index + match[0].length;
    assignments.push({ index: match.index, start: unquotedEnd - match[2]!.length, unquotedEnd, replacement: `${match[1]}=[scrubbed]` });
  }
  assignments.sort((left, right) => left.index - right.index);
  const chunks: string[] = [];
  let consumed = 0;
  for (const assignment of assignments) {
    if (assignment.index < consumed) continue;
    chunks.push(value.slice(consumed, assignment.index), assignment.replacement);
    consumed = sensitiveAssignmentEnd(value, assignment.start, assignment.unquotedEnd);
  }
  chunks.push(value.slice(consumed));
  return chunks.join("");
}
