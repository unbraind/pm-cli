/**
 * @module core/shared/author
 *
 * Provides shared primitives and utilities for Author.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentSessionContextFromSignals,
  type AgentEpisodeIdentity,
  type AgentSessionContext,
} from "./agent-session-context.js";

/** Stable provenance categories recorded beside newly appended history authors. */
export type AuthorSource = "asserted" | "configured" | "detected" | "unknown";

/** Stable source categories for model observations recorded in mutation history. */
export type AgentModelSource =
  | "override"
  | "environment"
  | "mcp_client"
  | "argv"
  | "host"
  | "session"
  | "probe";

/** Stable built-in provenance dimensions understood by the default runtime. */
export const AGENT_PROVENANCE_DIMENSIONS = [
  "model",
  "effort",
  "role",
  "topic",
  "version",
] as const;

/** Built-in, bounded local resolver names accepted by harness descriptors. */
export type AgentProvenanceResolver =
  | "ai_agent_version"
  | "claude_session_file";

/** One bounded provenance value and the signal class that supplied it. */
export interface AgentProvenanceObservation {
  /** Bounded descriptive value retained in local history. */
  value: string;
  /** Signal class that supplied the value. */
  source: AgentModelSource;
}

/**
 * Extensible provenance dimensions. A null value explicitly means that the
 * selected harness declared the dimension but exposed no value this run.
 */
export type AgentProvenance = Readonly<
  Record<string, AgentProvenanceObservation | null>
>;

/** Bounded reason explaining why one declared provenance dimension was absent. */
export type AgentProvenanceAbsenceReason =
  | "harness_unavailable"
  | "resolver_failed"
  | "resolver_not_configured"
  | "probes_disabled"
  | "invalid_value";

/** Machine-readable resolution outcome for one provenance dimension. */
export interface AgentProvenanceOutcome {
  /** Whether the dimension resolved without retaining private source material. */
  status: "resolved" | "unavailable" | "failed";
  /** Stable bounded reason for absent or rejected values. */
  reason?: AgentProvenanceAbsenceReason;
  /** Resolver name when a bounded local resolver was attempted. */
  resolver?: AgentProvenanceResolver;
  /** Stable inference contract version used by downstream analytics. */
  rule_version: "v1";
}

/** Privacy-bounded MCP client metadata that can participate in agent detection. */
export interface AgentClientInfo {
  /** Client or harness name reported during protocol initialization. */
  name: string;
  /** Optional client version retained only as an input signal. */
  version?: string;
  /** Optional model identifier reported by a trusted embedding host. */
  model?: string;
  /** Optional invocation/session identifier reported by an embedding host. */
  session?: string;
  /** Optional descriptive provenance supplied by an embedding host. */
  provenance?: Readonly<Record<string, string | undefined>>;
  /** Optional episode declaration supplied by an embedding host. */
  episode?: AgentEpisodeIdentity;
}

/** Declarative, side-effect-free signal definition for one agent harness. */
export interface HarnessSignalDescriptor {
  /** Stable lowercase namespace written to provenance fields. */
  harness: string;
  /** Environment keys whose non-blank presence identifies the harness. */
  environment_keys?: readonly string[];
  /** Environment keys checked in order for a model identifier. */
  model_environment_keys?: readonly string[];
  /** Environment keys checked in order for an invocation/session identifier. */
  session_environment_keys?: readonly string[];
  /** Extensible provenance dimension to ordered environment-key mappings. */
  provenance_environment_keys?: Readonly<
    Record<string, readonly string[] | undefined>
  >;
  /** Provenance dimensions mapped to audited built-in local resolvers. */
  provenance_resolvers?: Readonly<
    Record<string, AgentProvenanceResolver | undefined>
  >;
  /** Dimensions the harness is known not to expose through environment keys. */
  provenance_unavailable_dimensions?: readonly string[];
  /** Literal, case-insensitive executable or argument markers. */
  argv_markers?: readonly string[];
  /** Literal, case-insensitive MCP client-name markers. */
  client_names?: readonly string[];
}

type NormalizedHarnessSignalDescriptor = Required<HarnessSignalDescriptor>;

/** Public, privacy-safe agent observation shared by CLI, SDK, and MCP hosts. */
export interface DetectedAgentIdentity {
  /** Normalized harness namespace when automatic detection succeeded. */
  harness?: string;
  /** Model identifier observed from a bounded runtime signal. */
  model?: string;
  /** Signal class that supplied `model`. */
  model_source?: AgentModelSource;
  /** Transient invocation/session identifier available only to the current host. */
  session?: string;
  /** Privacy-safe stable fingerprint for the current harness invocation. */
  instance?: string;
  /** Extensible local-only descriptive provenance observations. */
  provenance?: AgentProvenance;
  /** Stable declared episode identity when the session supplied one. */
  episode?: AgentEpisodeIdentity;
}

/** Agent identity plus explicit outcomes for every built-in provenance dimension. */
export interface DiagnosedAgentIdentity extends DetectedAgentIdentity {
  /** Resolution outcomes that distinguish absence from resolver failure. */
  provenance_outcomes: Readonly<Record<string, AgentProvenanceOutcome>>;
}

/** Public, privacy-safe identity resolution result shared by CLI and SDK hosts. */
export interface ResolvedAuthorIdentity extends DetectedAgentIdentity {
  /** Stable author value written to mutation history. */
  author: string;
  /** How the effective author was selected. */
  source: AuthorSource;
}

/** Bounded runtime signals accepted by the pure harness detector. */
export interface HarnessDetectionSignals {
  /** Environment names and values supplied by the embedding runtime. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Executable and argument tokens for the current process. */
  argv?: readonly string[];
  /** Optional parent-process labels supplied by a host that already knows them. */
  process_labels?: readonly string[];
  /** Optional protocol client metadata supplied by an MCP or SDK host. */
  client_info?: AgentClientInfo;
  /** Invocation metadata supplied directly by an embedding host. */
  provenance?: Readonly<Record<string, string | undefined>>;
  /** Session-wide semantic context supplied by an embedding host. */
  session_context?: AgentSessionContext;
  /** Invocation-local descriptors appended after built-in and package signals. */
  descriptors?: readonly HarnessSignalDescriptor[];
  /** Disable local provenance probes for this invocation. */
  probes_enabled?: boolean;
  /** Working directory used to derive harness-owned session paths. */
  cwd?: string;
  /** Home directory override used by embedders and isolated tests. */
  home_dir?: string;
}

const authorIdentityStorage = new AsyncLocalStorage<ResolvedAuthorIdentity>();
const harnessDetectionStorage =
  new AsyncLocalStorage<HarnessDetectionSignals>();
interface WorkspaceHarnessSignals {
  descriptors: readonly NormalizedHarnessSignalDescriptor[];
  probesEnabled: boolean;
}

const workspaceHarnessSignalsStorage =
  new AsyncLocalStorage<WorkspaceHarnessSignals>();

/** Built-in agent descriptors evaluated before package and workspace additions. */
export const BUILTIN_HARNESS_SIGNAL_DESCRIPTORS: readonly HarnessSignalDescriptor[] =
  [
    {
      harness: "claude-code",
      environment_keys: ["CLAUDE_CODE", "CLAUDECODE"],
      model_environment_keys: ["ANTHROPIC_MODEL", "CLAUDE_MODEL"],
      session_environment_keys: ["CLAUDE_CODE_SESSION_ID"],
      provenance_environment_keys: {
        effort: ["CLAUDE_EFFORT"],
      },
      provenance_resolvers: {
        model: "claude_session_file",
        version: "claude_session_file",
      },
      provenance_unavailable_dimensions: ["role", "topic"],
      argv_markers: ["claude", "claude-code"],
      client_names: ["claude", "claude-code", "claude code"],
    },
    {
      harness: "codex",
      environment_keys: ["CODEX_HOME", "CODEX_CI", "CODEX_THREAD_ID"],
      model_environment_keys: ["CODEX_MODEL"],
      session_environment_keys: ["CODEX_THREAD_ID"],
      provenance_environment_keys: {
        effort: ["CODEX_REASONING_EFFORT", "CODEX_EFFORT"],
        role: ["CODEX_SESSION_ROLE"],
      },
      provenance_resolvers: { version: "ai_agent_version" },
      provenance_unavailable_dimensions: ["topic"],
      argv_markers: ["codex"],
      client_names: ["codex"],
    },
    {
      harness: "pi",
      environment_keys: ["PI_AGENT", "PI_CODING_AGENT"],
      model_environment_keys: ["PI_MODEL"],
      session_environment_keys: ["PI_SESSION_ID"],
      provenance_unavailable_dimensions: ["effort", "role", "topic"],
      argv_markers: ["pi"],
      client_names: ["pi"],
    },
    {
      harness: "opencode",
      environment_keys: ["OPENCODE", "OPENCODE_SESSION_ID"],
      model_environment_keys: ["OPENCODE_MODEL"],
      session_environment_keys: ["OPENCODE_SESSION_ID"],
      provenance_unavailable_dimensions: ["effort", "role", "topic"],
      argv_markers: ["opencode"],
      client_names: ["opencode"],
    },
    {
      harness: "cursor",
      environment_keys: ["CURSOR_AGENT", "CURSOR_TRACE_ID"],
      model_environment_keys: ["CURSOR_MODEL"],
      session_environment_keys: ["CURSOR_TRACE_ID"],
      provenance_unavailable_dimensions: ["effort", "role", "topic"],
      argv_markers: ["cursor"],
      client_names: ["cursor"],
    },
    {
      harness: "aider",
      environment_keys: ["AIDER", "AIDER_MODEL"],
      model_environment_keys: ["AIDER_MODEL"],
      session_environment_keys: ["AIDER_SESSION_ID"],
      provenance_unavailable_dimensions: ["effort", "role", "topic"],
      argv_markers: ["aider"],
      client_names: ["aider"],
    },
    {
      harness: "gemini-cli",
      environment_keys: ["GEMINI_CLI", "GEMINI_CLI_HOME"],
      model_environment_keys: ["GEMINI_MODEL"],
      session_environment_keys: ["GEMINI_CLI_SESSION_ID"],
      provenance_unavailable_dimensions: ["effort", "role", "topic"],
      argv_markers: ["gemini", "gemini-cli"],
      client_names: ["gemini", "gemini-cli", "gemini cli"],
    },
    {
      harness: "ci",
      environment_keys: ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"],
      provenance_unavailable_dimensions: ["model", "effort", "role", "topic"],
      argv_markers: [],
      client_names: [],
    },
  ];

interface RegisteredHarnessSignalDescriptor {
  descriptor: NormalizedHarnessSignalDescriptor;
  registrations: number;
}

const registeredHarnessSignalDescriptors = new Map<
  string,
  RegisteredHarnessSignalDescriptor
>();

const HARNESS_NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function nonBlank(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function boundedUniqueStrings(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .slice(0, 64)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => value.slice(0, 128)),
    ),
  ];
}

function normalizeHarnessSignalDescriptor(
  descriptor: HarnessSignalDescriptor,
): NormalizedHarnessSignalDescriptor {
  const harness = descriptor.harness.trim().toLowerCase();
  if (!HARNESS_NAMESPACE_PATTERN.test(harness)) {
    throw new Error(
      `Invalid harness signal descriptor namespace: ${descriptor.harness}`,
    );
  }
  return {
    harness,
    environment_keys: boundedUniqueStrings(descriptor.environment_keys),
    model_environment_keys: boundedUniqueStrings(
      descriptor.model_environment_keys,
    ),
    session_environment_keys: boundedUniqueStrings(
      descriptor.session_environment_keys,
    ),
    provenance_environment_keys: Object.fromEntries(
      Object.entries(descriptor.provenance_environment_keys ?? {})
        .slice(0, 32)
        .map(([dimension, keys]) => [
          dimension.trim().toLowerCase().slice(0, 64),
          boundedUniqueStrings(keys),
        ])
        .filter(([dimension]) =>
          HARNESS_NAMESPACE_PATTERN.test(dimension as string),
        ),
    ),
    provenance_resolvers: Object.fromEntries(
      Object.entries(descriptor.provenance_resolvers ?? {})
        .slice(0, 32)
        .map(([dimension, resolver]) => [
          dimension.trim().toLowerCase().slice(0, 64),
          resolver,
        ])
        .filter(
          (entry): entry is [string, AgentProvenanceResolver] =>
            typeof entry[0] === "string" &&
            HARNESS_NAMESPACE_PATTERN.test(entry[0]) &&
            (entry[1] === "ai_agent_version" ||
              entry[1] === "claude_session_file"),
        ),
    ),
    provenance_unavailable_dimensions: boundedUniqueStrings(
      descriptor.provenance_unavailable_dimensions,
    ).map((value) => value.toLowerCase()),
    argv_markers: boundedUniqueStrings(descriptor.argv_markers).map((value) =>
      value.toLowerCase(),
    ),
    client_names: boundedUniqueStrings(descriptor.client_names).map((value) =>
      value.toLowerCase(),
    ),
  };
}

const NORMALIZED_BUILTIN_HARNESS_SIGNAL_DESCRIPTORS =
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.map(normalizeHarnessSignalDescriptor);

function descriptorEquals(
  left: NormalizedHarnessSignalDescriptor,
  right: NormalizedHarnessSignalDescriptor,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function literalSignalMatches(value: string, marker: string): boolean {
  const segments = value
    .toLowerCase()
    .slice(0, 512)
    .split(/[/\\\s:=]+/u)
    .filter((segment) => segment.length > 0);
  return segments.includes(marker) || value.trim().toLowerCase() === marker;
}

function currentHarnessSignalDescriptors(
  localDescriptors: readonly HarnessSignalDescriptor[] = [],
): readonly NormalizedHarnessSignalDescriptor[] {
  const descriptors = [
    ...NORMALIZED_BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
    ...[...registeredHarnessSignalDescriptors.values()].map(
      (entry) => entry.descriptor,
    ),
    ...(workspaceHarnessSignalsStorage.getStore()?.descriptors ?? []),
    ...localDescriptors.map(normalizeHarnessSignalDescriptor),
  ];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.harness)) {
      throw new Error(
        `Harness signal descriptor collision for "${descriptor.harness}"`,
      );
    }
    seen.add(descriptor.harness);
  }
  return descriptors;
}

function firstEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[] | undefined,
): string | undefined {
  for (const key of keys ?? []) {
    const value = nonBlank(env[key]);
    if (value) return value.slice(0, 256);
  }
  return undefined;
}

function provenanceFromArgv(
  argv: readonly string[],
  dimension: string,
): string | undefined {
  const flaggedValue = provenanceFlagValue(argv, dimension);
  if (flaggedValue !== undefined) return flaggedValue;
  if (dimension === "topic") {
    return argv
      .slice(0, 16)
      .map((token) => token.trim())
      .find((token) => /^pm-[a-z0-9][a-z0-9-]{2,63}$/u.test(token));
  }
  if (dimension === "role") {
    const command = argv
      .slice(0, 8)
      .map((token) => token.trim().toLowerCase())
      .find((token) =>
        ["claim", "create", "update", "close", "release", "review"].includes(
          token,
        ),
      );
    if (command === "review") return "reviewer";
    if (command) return "implementer";
  }
  return undefined;
}

function provenanceFlagValue(
  argv: readonly string[],
  dimension: string,
): string | undefined {
  const acceptedFlags =
    dimension === "model"
      ? ["--model", "--agent-model"]
      : [`--agent-${dimension}`];
  const tokens = argv.slice(0, 8);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.slice(0, 512);
    if (acceptedFlags.includes(token)) {
      return nonBlank(tokens[index + 1])?.slice(0, 256);
    }
    const prefix = acceptedFlags.find((flag) => token.startsWith(`${flag}=`));
    if (prefix) {
      return nonBlank(token.slice(prefix.length + 1))?.slice(0, 256);
    }
  }
  return undefined;
}

const AGENT_ROLE_VALUES = new Set([
  "implementation",
  "implementer",
  "investigator",
  "orchestrator",
  "planner",
  "release-operator",
  "reviewer",
]);

function normalizeProvenanceValue(
  dimension: string,
  value: string | undefined,
): string | undefined {
  if (dimension !== "role" || value === undefined) return value;
  const normalized = value.trim().toLowerCase().replaceAll(/[_\s]+/gu, "-");
  return AGENT_ROLE_VALUES.has(normalized) ? normalized : undefined;
}

function boundedProvenanceValue(
  provenance: Readonly<Record<string, string | undefined>> | undefined,
  dimension: string,
): string | undefined {
  return nonBlank(provenance?.[dimension])?.slice(0, 256);
}

const MAX_PROVENANCE_PROBE_BYTES = 1_048_576;

function parseClaudeProvenanceLine(
  line: string,
  dimension: string,
): string | undefined {
  if (line.length === 0 || line.length > 262_144) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const message =
    typeof record.message === "object" && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const value = dimension === "model" ? message?.model : record.version;
  return nonBlank(value)?.slice(0, 256);
}

function readClaudeSessionProvenance(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const session = nonBlank(env.CLAUDE_CODE_SESSION_ID);
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/u.test(session)) return undefined;
  const workspace = path.resolve(signals.cwd ?? process.cwd());
  const encodedWorkspace = workspace.replaceAll(/[^A-Za-z0-9-]/gu, "-");
  const sessionPath = path.join(
    signals.home_dir ?? os.homedir(),
    ".claude",
    "projects",
    encodedWorkspace,
    `${session}.jsonl`,
  );
  try {
    const file = fs.openSync(sessionPath, "r");
    try {
      const size = fs.fstatSync(file).size;
      const length = Math.min(size, MAX_PROVENANCE_PROBE_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(file, buffer, 0, length, Math.max(0, size - length));
      const lines = buffer.toString("utf8").split("\n").reverse();
      for (const line of lines.slice(0, 4_096)) {
        const value = parseClaudeProvenanceLine(line, dimension);
        if (value) return value;
      }
      return undefined;
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return undefined;
  }
}

function resolveProvenanceProbe(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
): string | undefined {
  const workspaceSignals = workspaceHarnessSignalsStorage.getStore();
  const enabled =
    signals.probes_enabled !== false &&
    workspaceSignals?.probesEnabled !== false &&
    !["0", "false", "off"].includes(
      nonBlank(env.PM_AGENT_PROBES)?.toLowerCase() ?? "",
    );
  if (!enabled) return undefined;
  const resolver = descriptor?.provenance_resolvers[dimension];
  if (resolver === "claude_session_file") {
    return readClaudeSessionProvenance(dimension, signals, env);
  }
  if (resolver === "ai_agent_version") {
    const value = nonBlank(env.AI_AGENT);
    if (!value) return undefined;
    const match =
      /(?:^|[@/\s])v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)$/u.exec(value);
    return match?.[1]?.slice(0, 256);
  }
  return undefined;
}

function effectiveHarnessDetectionSignals(
  signals: HarnessDetectionSignals | undefined,
): HarnessDetectionSignals {
  if (signals) return signals;
  return (
    harnessDetectionStorage.getStore() ?? {
      env: process.env,
      argv: process.argv,
    }
  );
}

function descriptorMatchesSignals(
  descriptor: NormalizedHarnessSignalDescriptor,
  env: Readonly<Record<string, string | undefined>>,
  labels: readonly string[],
  clientName: string,
): boolean {
  const environmentMatch = descriptor.environment_keys.some(
    (key) => nonBlank(env[key]) !== undefined,
  );
  const argvMatch = descriptor.argv_markers.some((marker) =>
    labels.some((label) => {
      const normalizedPath = label.replaceAll("\\", "/");
      return literalSignalMatches(
        normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1),
        marker,
      );
    }),
  );
  const clientMatch = descriptor.client_names.some(
    (name) => clientName === name || literalSignalMatches(clientName, name),
  );
  return environmentMatch || argvMatch || clientMatch;
}

function resolveAgentProvenanceObservation(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  sessionContext: AgentSessionContext | undefined,
): AgentProvenanceObservation | undefined {
  const overrideKey = `PM_AGENT_${dimension.toUpperCase().replaceAll("-", "_")}`;
  const hostResolvedDimensions = new Set([
    ...AGENT_PROVENANCE_DIMENSIONS,
    ...Object.keys(descriptor?.provenance_environment_keys ?? {}),
  ]);
  let overrideValue: string | undefined;
  let argvValue: string | undefined;
  if (hostResolvedDimensions.has(dimension)) {
    overrideValue = normalizeProvenanceValue(
      dimension,
      nonBlank(env[overrideKey])?.slice(0, 256),
    );
    argvValue = provenanceFromArgv(signals.argv ?? [], dimension);
  }
  const environmentKeysByDimension: Readonly<
    Record<string, readonly string[] | undefined>
  > = {
    ...descriptor?.provenance_environment_keys,
    model: descriptor?.model_environment_keys,
  };
  const clientProvenance = {
    ...signals.client_info?.provenance,
    model: signals.client_info?.model,
  };
  const values = [
    overrideValue,
    boundedProvenanceValue(sessionContext?.provenance, dimension),
    normalizeProvenanceValue(
      dimension,
      firstEnvironmentValue(env, environmentKeysByDimension[dimension]),
    ),
    normalizeProvenanceValue(
      dimension,
      boundedProvenanceValue(clientProvenance, dimension),
    ),
    normalizeProvenanceValue(
      dimension,
      boundedProvenanceValue(signals.provenance, dimension),
    ),
    normalizeProvenanceValue(dimension, argvValue),
    resolveProvenanceProbe(dimension, signals, env, descriptor),
  ];
  const sources: readonly AgentModelSource[] = [
    "override",
    "session",
    "environment",
    "mcp_client",
    "host",
    "argv",
    "probe",
  ];
  const candidates = sources.map((source, index) => ({
    value: values[index],
    source,
  }));
  return candidates.find(
    (candidate): candidate is { value: string; source: AgentModelSource } =>
      candidate.value !== undefined,
  );
}

function resolveAgentProvenance(
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  sessionContext: AgentSessionContext | undefined,
): AgentProvenance {
  const descriptorDimensions = Object.keys(
    descriptor?.provenance_environment_keys ?? {},
  );
  const dimensions = new Set([
    ...AGENT_PROVENANCE_DIMENSIONS,
    ...descriptorDimensions,
    ...Object.keys(descriptor?.provenance_resolvers ?? {}),
    ...Object.keys(signals.provenance ?? {}),
    ...Object.keys(signals.client_info?.provenance ?? {}),
    ...Object.keys(sessionContext?.provenance ?? {}),
  ]);
  const observations: Record<string, AgentProvenanceObservation | null> = {};
  for (const dimension of dimensions) {
    const observed = resolveAgentProvenanceObservation(
      dimension,
      signals,
      env,
      descriptor,
      sessionContext,
    );
    if (observed) {
      observations[dimension] = observed;
    } else if (
      descriptor &&
      (dimension !== "version" ||
        descriptor.provenance_unavailable_dimensions.includes(dimension))
    ) {
      observations[dimension] = null;
    }
  }
  return observations;
}

/**
 * Register package-provided harness signals until the returned disposer runs.
 *
 * Built-in and conflicting package namespaces are rejected deterministically.
 * Re-registering an identical package descriptor is reference counted so
 * repeated extension activation remains idempotent.
 */
export function registerHarnessSignalDescriptors(
  descriptors: readonly HarnessSignalDescriptor[],
): () => void {
  const normalized = descriptors.map(normalizeHarnessSignalDescriptor);
  const builtins = new Map(
    NORMALIZED_BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.map((descriptor) => [
      descriptor.harness,
      descriptor,
    ]),
  );
  const seen = new Set<string>();
  for (const descriptor of normalized) {
    if (seen.has(descriptor.harness) || builtins.has(descriptor.harness)) {
      throw new Error(
        `Harness signal descriptor collision for "${descriptor.harness}"`,
      );
    }
    const registered = registeredHarnessSignalDescriptors.get(
      descriptor.harness,
    );
    if (registered && !descriptorEquals(registered.descriptor, descriptor)) {
      throw new Error(
        `Harness signal descriptor collision for "${descriptor.harness}"`,
      );
    }
    seen.add(descriptor.harness);
  }
  for (const descriptor of normalized) {
    const registered = registeredHarnessSignalDescriptors.get(
      descriptor.harness,
    );
    registeredHarnessSignalDescriptors.set(descriptor.harness, {
      descriptor,
      registrations: (registered?.registrations ?? 0) + 1,
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const descriptor of normalized) {
      const registered = registeredHarnessSignalDescriptors.get(
        descriptor.harness,
      );
      if (!registered || registered.registrations <= 1) {
        registeredHarnessSignalDescriptors.delete(descriptor.harness);
      } else {
        registered.registrations -= 1;
      }
    }
  };
}

/** Run one invocation with host-provided detection signals available downstream. */
export function runWithHarnessDetectionSignals<T>(
  signals: HarnessDetectionSignals,
  callback: () => T,
): T {
  return harnessDetectionStorage.run(signals, callback);
}

/** Run one invocation with workspace-provided descriptors available downstream. */
export function runWithWorkspaceHarnessSignalDescriptors<T>(
  descriptors: readonly HarnessSignalDescriptor[],
  callback: () => T,
  options: { probesEnabled?: boolean } = {},
): T {
  const normalized = descriptors.map(normalizeHarnessSignalDescriptor);
  currentHarnessSignalDescriptors(normalized);
  return workspaceHarnessSignalsStorage.run(
    {
      descriptors: normalized,
      probesEnabled: options.probesEnabled !== false,
    },
    callback,
  );
}

/**
 * Detect structured agent provenance from bounded caller-supplied signals.
 *
 * The function is deterministic and side-effect free. Descriptor values are
 * treated as literal strings; they never execute regexes, commands, filesystem
 * traversal, or network requests.
 */
export function detectAgentIdentity(
  signals?: HarnessDetectionSignals,
): DetectedAgentIdentity {
  const effectiveSignals = effectiveHarnessDetectionSignals(signals);
  const env = effectiveSignals.env ?? {};
  const descriptors = currentHarnessSignalDescriptors(
    effectiveSignals.descriptors,
  );
  const labels = [
    ...(effectiveSignals.argv ?? []).slice(0, 3),
    ...(effectiveSignals.process_labels ?? []),
  ]
    .slice(0, 64)
    .map((token) => token.slice(0, 512));
  const clientName =
    effectiveSignals.client_info?.name.trim().toLowerCase() ?? "";
  const descriptor = descriptors.find((candidate) =>
    descriptorMatchesSignals(candidate, env, labels, clientName),
  );
  const sessionContext = resolveAgentSessionContextFromSignals(
    effectiveSignals,
    env,
  );
  const provenance = resolveAgentProvenance(
    effectiveSignals,
    env,
    descriptor,
    sessionContext,
  );
  const modelCandidate = provenance.model;
  const session = [
    firstEnvironmentValue(env, descriptor?.session_environment_keys),
    nonBlank(effectiveSignals.client_info?.session)?.slice(0, 256),
  ].find((candidate) => candidate !== undefined);
  const instance =
    descriptor?.harness && session
      ? createHash("sha256")
          .update(`pm-agent-instance:v1\0${descriptor.harness}\0${session}`)
          .digest("hex")
          .slice(0, 24)
      : undefined;
  const entries: Array<
    [
      keyof DetectedAgentIdentity,
      string | AgentProvenance | AgentEpisodeIdentity | undefined,
    ]
  > = [
    ["harness", descriptor?.harness],
    ["model", modelCandidate?.value],
    ["model_source", modelCandidate?.source],
    ["session", session],
    ["instance", instance],
    ["provenance", Object.keys(provenance).length > 0 ? provenance : undefined],
    ["episode", sessionContext.episode],
  ];
  return Object.fromEntries(
    entries.filter((entry) => entry[1] !== undefined),
  ) as DetectedAgentIdentity & { provenance?: AgentProvenance };
}

function resolveProvenanceOutcome(
  dimension: string,
  identity: DetectedAgentIdentity,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  env: Readonly<Record<string, string | undefined>>,
  probesEnabled: boolean,
  invalidValue: boolean,
): AgentProvenanceOutcome {
  const resolver = descriptor?.provenance_resolvers[dimension];
  if (identity.provenance?.[dimension]) {
    return {
      status: "resolved",
      ...(resolver ? { resolver } : {}),
      rule_version: "v1",
    };
  }
  if (invalidValue) {
    return {
      status: "unavailable",
      reason: "invalid_value",
      rule_version: "v1",
    };
  }
  if (resolver) {
    const resolverHasInput =
      resolver === "ai_agent_version"
        ? nonBlank(env.AI_AGENT) !== undefined
        : nonBlank(env.CLAUDE_CODE_SESSION_ID) !== undefined;
    const status = resolverHasInput && probesEnabled ? "failed" : "unavailable";
    const reason = !resolverHasInput
      ? "harness_unavailable"
      : probesEnabled
        ? "resolver_failed"
        : "probes_disabled";
    return { status, reason, resolver, rule_version: "v1" };
  }
  return {
    status: "unavailable",
    reason: descriptor?.provenance_unavailable_dimensions.includes(dimension)
      ? "harness_unavailable"
      : "resolver_not_configured",
    rule_version: "v1",
  };
}

/**
 * Diagnose provenance without exposing environment values, paths, or probe data.
 *
 * This additive SDK contract keeps legacy `detectAgentIdentity` projections
 * stable while giving health checks and history writers explicit absence states.
 */
export function diagnoseAgentIdentity(
  signals?: HarnessDetectionSignals,
): DiagnosedAgentIdentity {
  const effectiveSignals = effectiveHarnessDetectionSignals(signals);
  const identity = detectAgentIdentity(effectiveSignals);
  const descriptor = currentHarnessSignalDescriptors(
    effectiveSignals.descriptors,
  ).find((candidate) => candidate.harness === identity.harness);
  const env = effectiveSignals.env ?? {};
  const probesEnabled =
    effectiveSignals.probes_enabled !== false &&
    workspaceHarnessSignalsStorage.getStore()?.probesEnabled !== false &&
    !["0", "false", "off"].includes(
      nonBlank(env.PM_AGENT_PROBES)?.toLowerCase() ?? "",
    );
  const sessionContext = resolveAgentSessionContextFromSignals(
    effectiveSignals,
    env,
  );
  const invalidRoleValue = [
    env.PM_AGENT_ROLE,
    sessionContext.provenance?.role,
    firstEnvironmentValue(
      env,
      descriptor?.provenance_environment_keys.role,
    ),
    effectiveSignals.client_info?.provenance?.role,
    effectiveSignals.provenance?.role,
    provenanceFlagValue(effectiveSignals.argv ?? [], "role"),
  ].some((candidate) => {
    const value = nonBlank(candidate)?.slice(0, 256);
    return (
      value !== undefined &&
      normalizeProvenanceValue("role", value) === undefined
    );
  });
  const outcomes = Object.fromEntries(
    AGENT_PROVENANCE_DIMENSIONS.map((dimension) => [
      dimension,
      resolveProvenanceOutcome(
        dimension,
        identity,
        descriptor,
        env,
        probesEnabled,
        dimension === "role" && invalidRoleValue,
      ),
    ]),
  );
  return { ...identity, provenance_outcomes: outcomes };
}

/** Reads the invocation-wide author override through the canonical environment seam. */
export function readAuthorEnvironment(): string | undefined {
  return process.env.PM_AUTHOR;
}

/** Updates or clears the invocation-wide author override through the canonical environment seam. */
export function writeAuthorEnvironment(author: string | undefined): void {
  if (author === undefined) delete process.env.PM_AUTHOR;
  else process.env.PM_AUTHOR = author;
}

/**
 * Detect a known agent harness from bounded, caller-supplied runtime signals.
 *
 * The function is pure: it performs no process traversal, subprocess launch,
 * network access, or telemetry emission. Hosts can therefore use it in
 * latency-sensitive mutation paths and test every detection branch directly.
 */
export function detectHarnessIdentity(
  signals?: HarnessDetectionSignals,
): string | undefined {
  return detectAgentIdentity(signals).harness;
}

/**
 * Resolve one mutation identity using the stable precedence contract:
 * explicit argument, `PM_AUTHOR`, configured default, detected harness, then
 * anonymous fallback.
 */
export function resolveAuthorIdentity(
  candidate: string | undefined,
  fallback: string | undefined,
  signals?: HarnessDetectionSignals,
): ResolvedAuthorIdentity {
  const effectiveSignals = effectiveHarnessDetectionSignals(signals);
  const detected = detectAgentIdentity(effectiveSignals);
  if (candidate !== undefined) {
    const explicit = nonBlank(candidate);
    return explicit
      ? { author: explicit, source: "asserted", ...detected }
      : { author: "unknown", source: "unknown", ...detected };
  }
  if (effectiveSignals.env?.PM_AUTHOR !== undefined) {
    const environment = nonBlank(effectiveSignals.env.PM_AUTHOR);
    return environment
      ? { author: environment, source: "asserted", ...detected }
      : { author: "unknown", source: "unknown", ...detected };
  }
  const configured = nonBlank(fallback);
  if (configured) {
    return { author: configured, source: "configured", ...detected };
  }
  if (detected.harness) {
    return {
      author: `harness:${detected.harness}`,
      source: "detected",
      ...detected,
    };
  }
  return { author: "unknown", source: "unknown", ...detected };
}

/** Return the provenance associated with the current resolved author. */
export function resolveHistoryAuthorSource(author: string): AuthorSource {
  const active = authorIdentityStorage.getStore();
  if (active?.author === author) {
    return active.source;
  }
  if (author.startsWith("harness:")) {
    return "detected";
  }
  return author === "unknown" ? "unknown" : "asserted";
}

/** Return structured agent provenance associated with the current author. */
export function resolveHistoryAgentIdentity(
  author: string,
): DetectedAgentIdentity {
  const active = authorIdentityStorage.getStore();
  if (active?.author !== author) {
    return author.startsWith("harness:")
      ? { harness: author.slice("harness:".length) }
      : {};
  }
  return {
    ...(active.harness ? { harness: active.harness } : {}),
    ...(active.model ? { model: active.model } : {}),
    ...(active.model_source ? { model_source: active.model_source } : {}),
    ...(active.session ? { session: active.session } : {}),
    ...(active.instance ? { instance: active.instance } : {}),
    ...(active.provenance ? { provenance: active.provenance } : {}),
    ...(active.episode ? { episode: active.episode } : {}),
  };
}

/**
 * Resolve the ownership principal for an automatically detected agent.
 *
 * Human-facing authors remain stable (`harness:codex`, for example), while a
 * privacy-safe invocation fingerprint prevents two concurrent sessions of the
 * same harness from silently sharing one claim. Explicit and configured
 * authors intentionally retain their asserted principal.
 */
export function resolveClaimPrincipal(author: string): string {
  const active = authorIdentityStorage.getStore();
  return active?.author === author &&
    active.source === "detected" &&
    active.instance
    ? `${author}#${active.instance}`
    : author;
}

/** Resolves the effective mutation author from explicit input, environment defaults, and fallback settings. */
export function resolveAuthor(
  candidate: string | undefined,
  fallback: string,
): string {
  const identity = resolveAuthorIdentity(candidate, fallback);
  authorIdentityStorage.enterWith(identity);
  return identity.author;
}
