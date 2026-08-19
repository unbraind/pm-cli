/**
 * @module sdk/agent/refusal-reachability
 *
 * Verifies real-entrypoint observations against refusal states declared by the
 * generated public error-code catalog.
 */
import * as nodeModule from "node:module";

import type {
  PmErrorCodeContract,
  PmErrorCodeClass,
} from "../error-code-catalog.js";

/** One recorded result from driving a real public entrypoint into a refusal. */
export interface PmRefusalProbeObservation {
  /** Stable probe identifier from the owning error-code contract. */
  probe_id: string;
  /** Public command entrypoint exercised by the probe. */
  entrypoint: string;
  /** Machine-readable code observed at the transport boundary. */
  code: string;
  /** Semantic exit class observed at the transport boundary. */
  exit_class: PmErrorCodeClass;
}

/** One actionable conformance failure. */
export interface PmRefusalReachabilityFinding {
  /** Stable finding kind for automation. */
  kind:
    | "duplicate_probe"
    | "missing_probe"
    | "wrong_entrypoint"
    | "wrong_error_code"
    | "wrong_exit_class"
    | "undeclared_probe";
  /** Probe whose declaration or observation failed. */
  probe_id: string;
  /** Human-readable mismatch summary. */
  detail: string;
}

/** Complete refusal-reachability conformance receipt. */
export interface PmRefusalReachabilityReport {
  /** Whether every declaration and observation agreed. */
  ok: boolean;
  /** Number of declared probes evaluated. */
  declared_probe_count: number;
  /** Number of real-entrypoint observations supplied. */
  observed_probe_count: number;
  /** Stable, sorted conformance findings. */
  findings: PmRefusalReachabilityFinding[];
}

/** Recovery-reference kinds emitted by structured refusal envelopes. */
export const PM_RECOVERY_REFERENCE_KINDS = [
  "suggested_retry",
  "candidate_command",
  "example",
  "next_step",
  "migration_hint",
  "restore_with",
] as const;

/** Recovery-reference kind emitted by a refusal. */
export type PmRecoveryReferenceKind =
  (typeof PM_RECOVERY_REFERENCE_KINDS)[number];

/** Behavioral promise attached to a recovery reference. */
export type PmRecoveryReferenceSemantics =
  | "recovery"
  | "replacement"
  | "behavior_preserving";

const RECOVERY_REFERENCE_FIELD_CONTRACTS = {
  suggested_retry: { kind: "suggested_retry", semantics: "recovery" },
  retry_command: { kind: "suggested_retry", semantics: "recovery" },
  candidate_command: { kind: "candidate_command", semantics: "recovery" },
  candidate_commands: { kind: "candidate_command", semantics: "recovery" },
  fallback_candidates: {
    kind: "candidate_command",
    semantics: "recovery",
    nested_value_field: "command",
  },
  next_best_command: { kind: "candidate_command", semantics: "recovery" },
  example: { kind: "example", semantics: "recovery" },
  examples: { kind: "example", semantics: "recovery" },
  next_step: { kind: "next_step", semantics: "recovery" },
  next_steps: { kind: "next_step", semantics: "recovery" },
  suggested_next_steps: { kind: "next_step", semantics: "recovery" },
  migration_hint: { kind: "migration_hint", semantics: "replacement" },
  migration_hints: { kind: "migration_hint", semantics: "replacement" },
  restore_with: {
    kind: "restore_with",
    semantics: "behavior_preserving",
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      kind: PmRecoveryReferenceKind;
      semantics: PmRecoveryReferenceSemantics;
      nested_value_field?: string;
    }
  >
>;

/** Literal envelope fields recognized as recovery-reference producers. */
export const PM_RECOVERY_REFERENCE_FIELDS = Object.freeze(
  Object.keys(RECOVERY_REFERENCE_FIELD_CONTRACTS) as Array<
    keyof typeof RECOVERY_REFERENCE_FIELD_CONTRACTS
  >,
);

/** Resolve an own recovery-field contract without trusting object prototypes. */
function recoveryReferenceContract(field: string) {
  if (!Object.hasOwn(RECOVERY_REFERENCE_FIELD_CONTRACTS, field))
    return undefined;
  return RECOVERY_REFERENCE_FIELD_CONTRACTS[
    field as keyof typeof RECOVERY_REFERENCE_FIELD_CONTRACTS
  ];
}

/** One source file supplied to the producer-census analyzer. */
export interface PmRecoveryProducerSource {
  /** Repository-relative source path. */
  path: string;
  /** Complete source text. */
  content: string;
}

/** One literal recovery field emitted from a source location. */
export interface PmRecoveryProducerLocation {
  /** Repository-relative producer source path. */
  path: string;
  /** One-based source line. */
  line: number;
  /** Literal structured-envelope field. */
  field: (typeof PM_RECOVERY_REFERENCE_FIELDS)[number];
  /** Normalized recovery kind. */
  kind: PmRecoveryReferenceKind;
}

/** Producer-census failure that requires a new field contract or producer. */
export interface PmRecoveryProducerCensusFinding {
  /** Stable finding kind. */
  kind: "invalid_source" | "missing_kind_producer" | "unknown_recovery_field";
  /** Source path or normalized kind. */
  subject: string;
  /** Actionable explanation. */
  detail: string;
}

/** Complete literal producer-table census for recovery references. */
export interface PmRecoveryProducerCensusReport {
  /** Whether every recovery kind has a producer and no unknown fields exist. */
  ok: boolean;
  /** Source files inspected. */
  scanned_file_count: number;
  /** Literal producer locations. */
  producer_count: number;
  /** Stable counts by normalized recovery kind. */
  producer_count_by_kind: Record<PmRecoveryReferenceKind, number>;
  /** Stable producer locations. */
  producers: PmRecoveryProducerLocation[];
  /** Missing-kind or unknown-field findings. */
  findings: PmRecoveryProducerCensusFinding[];
}

/** One derived promise that another invocation or command path is reachable. */
export interface PmRecoveryReferenceObligation {
  /** Stable reference identifier derived from its emitting envelope. */
  id: string;
  /** Refusal probe that emitted the reference. */
  probe_id: string;
  /** Typed recovery vocabulary rather than prose inference. */
  kind: PmRecoveryReferenceKind;
  /** Whether the reference recovers, replaces, or preserves the original behavior. */
  semantics: PmRecoveryReferenceSemantics;
  /** Exact emitted command or recovery text. */
  value: string;
}

/** Result of executing or resolving one derived recovery obligation. */
export interface PmRecoveryReferenceObservation {
  /** Stable obligation identifier. */
  id: string;
  /** Whether the promised recovery or command path was reachable. */
  reachable: boolean;
  /** How the promise was discharged. */
  proof: "executed" | "declared_command_path" | "linked_execution";
  /** Semantics actually demonstrated by the proof. */
  semantics: PmRecoveryReferenceSemantics;
}

/** Coverage totals for one emitted recovery-reference kind. */
export interface PmRecoveryReferenceKindCoverage {
  /** Typed reference kind. */
  kind: PmRecoveryReferenceKind;
  /** Derived obligations of this kind. */
  declared: number;
  /** Obligations with one observation. */
  observed: number;
  /** Obligations proven reachable. */
  passed: number;
}

/** One recovery-reference coverage failure. */
export interface PmRecoveryReferenceFinding {
  /** Stable finding kind for assurance and CI. */
  kind:
    | "duplicate_obligation"
    | "duplicate_observation"
    | "missing_observation"
    | "unreachable_reference"
    | "wrong_semantics"
    | "undeclared_observation";
  /** Obligation or observation identifier. */
  reference_id: string;
  /** Human-readable mismatch summary. */
  detail: string;
}

/** Complete cross-kind recovery-reference coverage receipt. */
export interface PmRecoveryReferenceReport {
  /** Whether every derived reference was uniquely proven reachable. */
  ok: boolean;
  /** Total references derived from real refusal envelopes. */
  declared_reference_count: number;
  /** Total reference observations supplied. */
  observed_reference_count: number;
  /** Reachable fraction across the declared obligation set. */
  pass_fraction: number;
  /** Stable coverage buckets, including zero-population kinds. */
  coverage_by_kind: PmRecoveryReferenceKindCoverage[];
  /** Stable, sorted conformance findings. */
  findings: PmRecoveryReferenceFinding[];
}

/** Per-kind runtime evidence; counts do not claim one observation per source location. */
export interface PmRecoveryProducerRuntimeCoverage {
  /** Typed recovery-reference kind. */
  kind: PmRecoveryReferenceKind;
  /** Literal source producers discovered for the kind. */
  source_producers: number;
  /** Distinct runtime values observed for the kind. */
  runtime_values: number;
}

/** Unified per-kind source-census and runtime-value coverage receipt. */
export interface PmRecoveryProducerRuntimeReport {
  /** Whether every source-declared kind emitted at least one runtime value. */
  ok: boolean;
  /** Source producer denominator. */
  source_producer_count: number;
  /** Distinct runtime-value denominator. */
  runtime_value_count: number;
  /** Stable per-kind source and runtime coverage. */
  coverage_by_kind: PmRecoveryProducerRuntimeCoverage[];
  /** Kinds with source producers but no runtime evidence. */
  missing_runtime_kinds: PmRecoveryReferenceKind[];
}

/** One object-literal property retained after TypeScript syntax stripping. */
interface SourcePropertyToken {
  /** Literal identifier or quoted property name. */
  field: string;
  /** Zero-based offset preserved from the original source. */
  offset: number;
}

interface SourceSyntaxToken {
  /** Token category needed by the lightweight structural parser. */
  kind: "identifier" | "string" | "punctuator";
  /** Decoded identifier/string or literal punctuator. */
  value: string;
  /** Zero-based offset preserved from the original source. */
  offset: number;
}

const SOURCE_REGEXP_PREFIX_PUNCTUATORS = new Set([
  ..."=([{,:;!?&|+-*%^~<>",
  "=>",
]);

interface SourceDelimiterFrame {
  /** Delimiter role used to distinguish object members from blocks and patterns. */
  kind: "object" | "block" | "pattern" | "paren" | "array";
  /** Whether the next token may begin a static object member. */
  member_start?: boolean;
  /** Candidates committed only if this frame remains an object expression. */
  candidates?: SourcePropertyToken[];
  /** Whether a parenthesized region is a declared function parameter list. */
  parameter_list?: boolean;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function skipQuotedSourceToken(
  source: string,
  index: number,
): { next: number; value: string } {
  const quote = source[index];
  let next = index + 1;
  let value = "";
  while (next < source.length && source[next] !== quote) {
    if (source[next] === "\\") next += 2;
    else {
      value += source[next];
      next += 1;
    }
  }
  if (source[next] === quote) next += 1;
  return { next, value };
}

function canStartRegularExpression(
  previous: SourceSyntaxToken | undefined,
): boolean {
  return (
    previous === undefined ||
    (previous.kind === "punctuator" &&
      SOURCE_REGEXP_PREFIX_PUNCTUATORS.has(previous.value)) ||
    (previous.kind === "identifier" &&
      ["return", "case", "throw", "else", "yield"].includes(previous.value))
  );
}

function sourceTriviaEnd(source: string, index: number): number | undefined {
  if (/\s/u.test(source[index]!)) return index + 1;
  if (source.startsWith("//", index)) {
    const newline = source.indexOf("\n", index + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (!source.startsWith("/*", index)) return undefined;
  // stripTypeScriptTypes validates block-comment termination before tokenization.
  return source.indexOf("*/", index + 2) + 2;
}

function regularExpressionEnd(
  source: string,
  index: number,
  previous: SourceSyntaxToken | undefined,
): number | undefined {
  if (source[index] !== "/" || !canStartRegularExpression(previous))
    return undefined;
  let next = index + 1;
  let inClass = false;
  while (next < source.length) {
    if (source[next] === "\\") next += 2;
    else if (source[next] === "[") {
      inClass = true;
      next += 1;
    } else if (source[next] === "]") {
      inClass = false;
      next += 1;
    } else if (source[next] === "/" && !inClass) {
      next += 1;
      while (/[A-Za-z]/u.test(source.charAt(next))) next += 1;
      return next;
    } else next += 1;
  }
  return next;
}

function readSourceSyntaxToken(
  source: string,
  index: number,
): { next: number; token?: SourceSyntaxToken } {
  const character = source[index]!;
  if (character === "'" || character === '"' || character === "`") {
    const quoted = skipQuotedSourceToken(source, index);
    return character === "`"
      ? { next: quoted.next }
      : {
          next: quoted.next,
          token: { kind: "string", value: quoted.value, offset: index + 1 },
        };
  }
  if (/[A-Za-z_$]/u.test(character)) {
    let next = index + 1;
    while (/[A-Za-z0-9_$]/u.test(source[next] ?? "")) next += 1;
    return {
      next,
      token: {
        kind: "identifier",
        value: source.slice(index, next),
        offset: index,
      },
    };
  }
  const punctuator = source.startsWith("=>", index) ? "=>" : character;
  return {
    next: index + punctuator.length,
    token: { kind: "punctuator", value: punctuator, offset: index },
  };
}

/** Tokenize executable JavaScript while ignoring comments, templates, and regex bodies. */
function tokenizeExecutableSource(source: string): SourceSyntaxToken[] {
  const tokens: SourceSyntaxToken[] = [];
  let index = 0;
  while (index < source.length) {
    const ignoredEnd = sourceTriviaEnd(source, index);
    if (ignoredEnd !== undefined) {
      index = ignoredEnd;
      continue;
    }
    const regexEnd = regularExpressionEnd(source, index, tokens.at(-1));
    if (regexEnd !== undefined) {
      index = regexEnd;
      continue;
    }
    const read = readSourceSyntaxToken(source, index);
    if (read.token) tokens.push(read.token);
    index = read.next;
  }
  return tokens;
}

const SOURCE_BRACE_FRAME_KINDS = new Set<SourceDelimiterFrame["kind"]>([
  "object",
  "block",
  "pattern",
]);
const SOURCE_PATTERN_DECLARATIONS = new Set(["const", "let", "var"]);
const SOURCE_CLOSING_TOKENS = new Set(["}", ")", "]"]);
const SOURCE_OBJECT_PRECEDERS = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  "?",
  "return",
]);

function objectFrameKind(
  tokens: readonly SourceSyntaxToken[],
  index: number,
  stack: readonly SourceDelimiterFrame[],
): SourceDelimiterFrame["kind"] {
  const enclosingBrace = [...stack]
    .reverse()
    .find((frame) => SOURCE_BRACE_FRAME_KINDS.has(frame.kind));
  if (enclosingBrace?.kind === "pattern") return "pattern";
  if (stack.at(-1)?.kind === "paren" && stack.at(-1)?.parameter_list)
    return "pattern";
  const previous = tokens[index - 1];
  if (
    previous?.kind === "identifier" &&
    SOURCE_PATTERN_DECLARATIONS.has(previous.value)
  ) {
    return "pattern";
  }
  if (previous?.value === "=>" || previous?.value === ")") return "block";
  return previous && SOURCE_OBJECT_PRECEDERS.has(previous.value)
    ? "object"
    : "block";
}

function openingSourceFrame(
  tokens: readonly SourceSyntaxToken[],
  index: number,
  stack: readonly SourceDelimiterFrame[],
): SourceDelimiterFrame | undefined {
  const token = tokens[index]!;
  if (token.value === "{") {
    const kind = objectFrameKind(tokens, index, stack);
    return {
      kind,
      ...(kind === "object" ? { member_start: true, candidates: [] } : {}),
    };
  }
  if (token.value === "[") return { kind: "array" };
  if (token.value !== "(") return undefined;
  const previous = tokens[index - 1];
  const beforePrevious = tokens[index - 2];
  const parameterList =
    previous?.value === "function" || beforePrevious?.value === "function";
  return { kind: "paren", ...(parameterList ? { parameter_list: true } : {}) };
}

function staticObjectMember(
  frame: SourceDelimiterFrame | undefined,
  token: SourceSyntaxToken,
  next: SourceSyntaxToken | undefined,
): SourcePropertyToken | undefined {
  if (
    frame?.kind !== "object" ||
    !frame.member_start ||
    (token.kind !== "identifier" && token.kind !== "string") ||
    next?.value !== ":" ||
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(token.value)
  ) {
    return undefined;
  }
  return { field: token.value, offset: token.offset };
}

function isPatternLikeObjectClosure(
  tokens: readonly SourceSyntaxToken[],
  index: number,
): boolean {
  return (
    (tokens[index + 1]?.value === ")" && tokens[index + 2]?.value === "=>") ||
    tokens[index + 1]?.value === "="
  );
}

/** Parse static object-literal members without treating patterns or labels as producers. */
function scanSourcePropertyTokens(source: string): SourcePropertyToken[] {
  const tokens = tokenizeExecutableSource(
    nodeModule.stripTypeScriptTypes(source, { mode: "strip" }),
  );
  const properties: SourcePropertyToken[] = [];
  const stack: SourceDelimiterFrame[] = [];
  for (const [index, token] of tokens.entries()) {
    const frame = stack.at(-1);
    const property = staticObjectMember(frame, token, tokens[index + 1]);
    if (property) frame!.candidates!.push(property);
    const opening = openingSourceFrame(tokens, index, stack);
    if (opening) {
      stack.push(opening);
    } else if (SOURCE_CLOSING_TOKENS.has(token.value)) {
      const closed = stack.pop();
      if (
        closed?.kind === "object" &&
        !isPatternLikeObjectClosure(tokens, index)
      ) {
        properties.push(...closed.candidates!);
      }
    } else if (token.value === "," && frame?.kind === "object") {
      frame.member_start = true;
    } else if (frame?.kind === "object" && token.value !== ":") {
      frame.member_start = false;
    }
  }
  return properties;
}

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function sourceLineAtOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Census syntax-parsed structured-envelope producers without executing source code. */
export function censusPmRecoveryReferenceProducers(
  sources: readonly PmRecoveryProducerSource[],
): PmRecoveryProducerCensusReport {
  const producers: PmRecoveryProducerLocation[] = [];
  const findings: PmRecoveryProducerCensusFinding[] = [];
  for (const source of [...sources].sort((left, right) =>
    compareCodeUnits(left.path, right.path),
  )) {
    const lineStarts = sourceLineStarts(source.content);
    let properties: SourcePropertyToken[];
    try {
      properties = scanSourcePropertyTokens(source.content);
    } catch (error: unknown) {
      findings.push({
        kind: "invalid_source",
        subject: source.path,
        detail: `${source.path} could not be parsed for recovery producers: ${String(error)}.`,
      });
      continue;
    }
    for (const property of properties) {
      const field = property.field;
      const line = sourceLineAtOffset(lineStarts, property.offset);
      const contract = recoveryReferenceContract(field);
      if (contract) {
        producers.push({
          path: source.path,
          line,
          field: field as PmRecoveryProducerLocation["field"],
          kind: contract.kind,
        });
      } else if (
        /(?:retry_command|candidate_command|fallback_candidate|next_best_command|example|next_step|migration_hint|restore_with)/u.test(
          field,
        ) &&
        !/(?:_total|_truncated)$/u.test(field)
      ) {
        findings.push({
          kind: "unknown_recovery_field",
          subject: `${source.path}:${line}:${field}`,
          detail: `${field} resembles a recovery reference but has no typed field contract.`,
        });
      }
    }
  }
  const producerCountByKind = Object.fromEntries(
    PM_RECOVERY_REFERENCE_KINDS.map((kind) => [
      kind,
      producers.filter((producer) => producer.kind === kind).length,
    ]),
  ) as Record<PmRecoveryReferenceKind, number>;
  for (const kind of PM_RECOVERY_REFERENCE_KINDS) {
    if (producerCountByKind[kind] === 0) {
      findings.push({
        kind: "missing_kind_producer",
        subject: kind,
        detail: `No source producer emits the ${kind} recovery-reference kind.`,
      });
    }
  }
  producers.sort((left, right) =>
    left.path !== right.path
      ? compareCodeUnits(left.path, right.path)
      : left.line !== right.line
        ? left.line - right.line
        : compareCodeUnits(left.field, right.field),
  );
  findings.sort((left, right) =>
    left.subject !== right.subject
      ? compareCodeUnits(left.subject, right.subject)
      : compareCodeUnits(left.kind, right.kind),
  );
  return {
    ok: findings.length === 0,
    scanned_file_count: sources.length,
    producer_count: producers.length,
    producer_count_by_kind: producerCountByKind,
    producers,
    findings,
  };
}

/** Derive typed obligations from every recognized recovery field in an emitted envelope. */
export function derivePmRecoveryReferenceObligations(
  probeId: string,
  envelope: unknown,
): PmRecoveryReferenceObligation[] {
  const obligations: PmRecoveryReferenceObligation[] = [];
  const visit = (value: unknown, path: readonly string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      const baseContract = recoveryReferenceContract(key);
      const contract =
        baseContract?.kind === "migration_hint" &&
        (value as { semantics?: unknown }).semantics === "behavior_preserving"
          ? { ...baseContract, semantics: "behavior_preserving" as const }
          : baseContract;
      const entries = [entry].flat();
      if (contract !== undefined) {
        entries.forEach((candidate, index) => {
          const nestedValueField =
            "nested_value_field" in contract &&
            typeof contract.nested_value_field === "string"
              ? contract.nested_value_field
              : undefined;
          const resolvedCandidate =
            nestedValueField &&
            typeof candidate === "object" &&
            candidate !== null &&
            !Array.isArray(candidate)
              ? (candidate as Record<string, unknown>)[nestedValueField]
              : candidate;
          if (
            typeof resolvedCandidate !== "string" ||
            resolvedCandidate.trim().length === 0
          )
            return;
          const coordinate = [...path, key, String(index)]
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          obligations.push({
            id: `${probeId}:${contract.kind}:${coordinate}`,
            probe_id: probeId,
            kind: contract.kind,
            semantics: contract.semantics,
            value: resolvedCandidate,
          });
        });
      }
      visit(entry, [...path, key]);
    }
  };
  visit(envelope, []);
  return obligations;
}

/** Compare declared refusal states with real-entrypoint observations. */
export function verifyPmRefusalReachability(
  catalog: readonly PmErrorCodeContract[],
  observations: readonly PmRefusalProbeObservation[],
): PmRefusalReachabilityReport {
  const declarations = catalog.flatMap((contract) =>
    (contract.owned_states ?? []).map((state) => ({ contract, state })),
  );
  const findings: PmRefusalReachabilityFinding[] = [];
  const observationsByProbe = new Map<string, PmRefusalProbeObservation>();
  for (const observation of observations) {
    if (observationsByProbe.has(observation.probe_id)) {
      findings.push({
        kind: "duplicate_probe",
        probe_id: observation.probe_id,
        detail: `Observation ${observation.probe_id} was supplied more than once.`,
      });
      continue;
    }
    observationsByProbe.set(observation.probe_id, observation);
  }
  const declaredProbeIds = new Set(
    declarations.map(({ state }) => state.probe_id),
  );
  for (const { contract, state } of declarations) {
    const observation = observationsByProbe.get(state.probe_id);
    if (!observation) {
      findings.push({
        kind: "missing_probe",
        probe_id: state.probe_id,
        detail: `No entrypoint observation was recorded for ${contract.code}.`,
      });
      continue;
    }
    if (observation.code !== contract.code) {
      findings.push({
        kind: "wrong_error_code",
        probe_id: state.probe_id,
        detail: `Expected ${contract.code}; observed ${observation.code}.`,
      });
    }
    if (observation.exit_class !== state.expected_exit_class) {
      findings.push({
        kind: "wrong_exit_class",
        probe_id: state.probe_id,
        detail: `Expected ${state.expected_exit_class}; observed ${observation.exit_class}.`,
      });
    }
    if (!state.entrypoints.includes(observation.entrypoint)) {
      findings.push({
        kind: "wrong_entrypoint",
        probe_id: state.probe_id,
        detail: `Expected one of ${state.entrypoints.join(", ")}; observed ${observation.entrypoint}.`,
      });
    }
  }
  for (const observation of observations) {
    if (!declaredProbeIds.has(observation.probe_id)) {
      findings.push({
        kind: "undeclared_probe",
        probe_id: observation.probe_id,
        detail: `Observation ${observation.probe_id} has no catalog declaration.`,
      });
    }
  }
  findings.sort((left, right) =>
    left.probe_id !== right.probe_id
      ? left.probe_id.localeCompare(right.probe_id)
      : left.kind.localeCompare(right.kind),
  );
  return {
    ok: findings.length === 0,
    declared_probe_count: declarations.length,
    observed_probe_count: observations.length,
    findings,
  };
}

/** Verify executable and declared-path proof for emitted recovery references. */
export function verifyPmRecoveryReferences(
  obligations: readonly PmRecoveryReferenceObligation[],
  observations: readonly PmRecoveryReferenceObservation[],
): PmRecoveryReferenceReport {
  const findings: PmRecoveryReferenceFinding[] = [];
  const declaredIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const obligation of obligations) {
    if (declaredIds.has(obligation.id)) {
      duplicateIds.add(obligation.id);
      findings.push({
        kind: "duplicate_obligation",
        reference_id: obligation.id,
        detail: `Recovery obligation ${obligation.id} was declared more than once.`,
      });
      continue;
    }
    declaredIds.add(obligation.id);
  }
  const observationsById = new Map<string, PmRecoveryReferenceObservation>();
  for (const observation of observations) {
    if (observationsById.has(observation.id)) {
      findings.push({
        kind: "duplicate_observation",
        reference_id: observation.id,
        detail: `Recovery reference ${observation.id} was observed more than once.`,
      });
      continue;
    }
    observationsById.set(observation.id, observation);
    if (!declaredIds.has(observation.id)) {
      findings.push({
        kind: "undeclared_observation",
        reference_id: observation.id,
        detail: `Recovery observation ${observation.id} has no emitted obligation.`,
      });
    }
  }
  for (const obligation of obligations) {
    if (duplicateIds.has(obligation.id)) continue;
    const observation = observationsById.get(obligation.id);
    if (!observation) {
      findings.push({
        kind: "missing_observation",
        reference_id: obligation.id,
        detail: `No reachability proof was recorded for ${obligation.kind} ${obligation.value}.`,
      });
    } else if (!observation.reachable) {
      findings.push({
        kind: "unreachable_reference",
        reference_id: obligation.id,
        detail: `Recovery reference ${obligation.value} did not reach its promised target.`,
      });
    } else if (observation.semantics !== obligation.semantics) {
      findings.push({
        kind: "wrong_semantics",
        reference_id: obligation.id,
        detail: `Recovery reference ${obligation.value} promised ${obligation.semantics}; proof demonstrated ${observation.semantics}.`,
      });
    }
  }
  const coverageByKind = PM_RECOVERY_REFERENCE_KINDS.map((kind) => {
    const kindObligations = obligations.filter(
      (obligation) => obligation.kind === kind,
    );
    const kindObservations = kindObligations
      .filter((obligation) => !duplicateIds.has(obligation.id))
      .map((obligation) => observationsById.get(obligation.id))
      .filter(
        (observation): observation is PmRecoveryReferenceObservation =>
          observation !== undefined,
      );
    return {
      kind,
      declared: kindObligations.length,
      observed: kindObservations.length,
      passed: kindObligations.filter((obligation) => {
        const observation = observationsById.get(obligation.id);
        return (
          !duplicateIds.has(obligation.id) &&
          observation?.reachable === true &&
          observation.semantics === obligation.semantics
        );
      }).length,
    };
  });
  findings.sort((left, right) =>
    left.reference_id !== right.reference_id
      ? left.reference_id.localeCompare(right.reference_id)
      : left.kind.localeCompare(right.kind),
  );
  const passed = coverageByKind.reduce(
    (total, coverage) => total + coverage.passed,
    0,
  );
  return {
    ok: findings.length === 0,
    declared_reference_count: obligations.length,
    observed_reference_count: observations.length,
    pass_fraction: declaredIds.size === 0 ? 1 : passed / declaredIds.size,
    coverage_by_kind: coverageByKind,
    findings,
  };
}

/** Join source-census counts to distinct emitted runtime values by typed kind. */
export function verifyPmRecoveryProducerRuntimeCoverage(
  census: PmRecoveryProducerCensusReport,
  obligations: readonly PmRecoveryReferenceObligation[],
): PmRecoveryProducerRuntimeReport {
  const runtimeValuesByKind = new Map<
    PmRecoveryReferenceKind,
    Set<string>
  >(
    PM_RECOVERY_REFERENCE_KINDS.map((kind) => [kind, new Set<string>()]),
  );
  for (const obligation of obligations) {
    runtimeValuesByKind.get(obligation.kind)!.add(obligation.value);
  }
  const coverageByKind = PM_RECOVERY_REFERENCE_KINDS.map((kind) => ({
    kind,
    source_producers: census.producer_count_by_kind[kind],
    runtime_values: runtimeValuesByKind.get(kind)!.size,
  }));
  const missingRuntimeKinds = coverageByKind
    .filter(
      ({ source_producers: sourceProducers, runtime_values: runtimeValues }) =>
        sourceProducers > 0 && runtimeValues === 0,
    )
    .map(({ kind }) => kind);
  return {
    ok: census.ok && missingRuntimeKinds.length === 0,
    source_producer_count: census.producer_count,
    runtime_value_count: coverageByKind.reduce(
      (total, { runtime_values: runtimeValues }) => total + runtimeValues,
      0,
    ),
    coverage_by_kind: coverageByKind,
    missing_runtime_kinds: missingRuntimeKinds,
  };
}

/** Honest kind-level name for the compatibility implementation above. */
export const verifyPmRecoveryKindRuntimeCoverage =
  verifyPmRecoveryProducerRuntimeCoverage;
