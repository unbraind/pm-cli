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
import {
  readAgentSemanticAttributionSync,
  type AgentSemanticAttribution,
} from "../session/session-state.js";
import { isFileAbsentError } from "../fs/fs-utils.js";

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
  | "probe"
  | "inferred";

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
  | "claude_session_file"
  | "codex_session_file";

/** One bounded provenance value and the signal class that supplied it. */
export interface AgentProvenanceObservation {
  /** Bounded descriptive value retained in local history. */
  value: string;
  /** Signal class that supplied the value. */
  source: AgentModelSource;
  /** Confidence attached to a semantic inference. */
  confidence?: "high" | "medium" | "low";
  /** Versioned inference rule when the value was derived. */
  rule_version?: "v2";
  /** Bounded item and lineage references supporting an inference. */
  evidence?: readonly string[];
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
  | "resolver_input_missing"
  | "resolver_failed"
  | "resolver_not_configured"
  | "probes_disabled"
  | "invalid_value";

/** Machine-readable resolution outcome for one provenance dimension. */
export interface AgentProvenanceOutcome {
  /** Whether the dimension resolved without retaining private source material. */
  status: "resolved" | "unavailable" | "not_configured" | "failed";
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

/** Versioned package-replaceable provenance contract for one agent harness. */
export interface AgentProvenanceAdapter {
  /** Public adapter contract revision. */
  contract_version: 1;
  /** Adapter implementation revision supplied by pm or a package. */
  adapter_version: string;
  /** Explicit replacement precedence; built-ins use zero. */
  priority: number;
  /** Stable lowercase harness namespace. */
  harness: string;
  /** Executable detection and provenance descriptor. */
  descriptor: HarnessSignalDescriptor;
  /** Provenance dimensions intentionally covered by the adapter. */
  supported_dimensions: readonly string[];
  /** Privacy classes the adapter may inspect. */
  native_sources: readonly (
    | "environment"
    | "argv"
    | "mcp_client"
    | "session_file"
  )[];
  /** Hard bounds shared by runtime probes and package review. */
  probe_policy: {
    max_bytes: number;
    max_lines: number;
    network_access: false;
    subprocess_access: false;
  };
  /** Stable normalization vocabulary declarations. */
  normalization: {
    model_family: "v1";
    effort: "v1";
    preserve_raw: true;
  };
  /** Confidence of a value read directly from the declared sources. */
  confidence: "high" | "medium" | "low";
  /** Bounded reasons for intentionally uncovered dimensions. */
  waivers?: Readonly<Record<string, string>>;
}

/** One raw and normalized adapter value with its stable vocabulary revision. */
export interface NormalizedAgentProvenanceAdapterValue {
  /** Bounded value retained exactly as observed. */
  raw: string;
  /** Stable cross-harness family or vocabulary value. */
  normalized: string;
  /** Normalization vocabulary revision. */
  vocabulary: "v1";
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
  /** Explicit harness-owned session file supplied by an embedding host. */
  session_file?: string;
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
      provenance_resolvers: {
        model: "codex_session_file",
        effort: "codex_session_file",
        version: "ai_agent_version",
      },
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

const PROVENANCE_PROBE_POLICY = Object.freeze({
  max_bytes: 1_048_576,
  max_lines: 4_096,
  network_access: false as const,
  subprocess_access: false as const,
});
const CODEX_PROVENANCE_PROBE_POLICY = Object.freeze({
  ...PROVENANCE_PROBE_POLICY,
  max_bytes: 4_194_304,
});
const HARNESS_NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function buildBuiltinProvenanceAdapter(
  descriptor: HarnessSignalDescriptor,
): AgentProvenanceAdapter {
  const unavailableDimensions =
    normalizeHarnessSignalDescriptor(
      descriptor,
    ).provenance_unavailable_dimensions;
  const dimensions = new Set([
    "model",
    "version",
    ...Object.keys(descriptor.provenance_environment_keys ?? {}),
    ...Object.keys(descriptor.provenance_resolvers ?? {}),
  ]);
  return Object.freeze({
    contract_version: 1 as const,
    adapter_version: "v1",
    priority: 0,
    harness: descriptor.harness,
    descriptor,
    supported_dimensions: Object.freeze([...dimensions].sort()),
    native_sources: Object.freeze([
      "environment" as const,
      "argv" as const,
      "mcp_client" as const,
      ...(Object.values(descriptor.provenance_resolvers ?? {}).some(
        (resolver) => resolver?.endsWith("session_file"),
      )
        ? (["session_file" as const] as const)
        : []),
    ]),
    probe_policy:
      descriptor.harness === "codex"
        ? CODEX_PROVENANCE_PROBE_POLICY
        : PROVENANCE_PROBE_POLICY,
    normalization: Object.freeze({
      model_family: "v1" as const,
      effort: "v1" as const,
      preserve_raw: true as const,
    }),
    confidence: "high" as const,
    waivers: Object.freeze(
      Object.fromEntries(
        unavailableDimensions.map((dimension) => [
          dimension,
          "Harness does not expose this dimension.",
        ]),
      ),
    ),
  });
}

/** Built-in versioned adapters for supported interactive agent harnesses. */
export const BUILTIN_AGENT_PROVENANCE_ADAPTERS: readonly AgentProvenanceAdapter[] =
  Object.freeze(
    BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.filter(
      (descriptor) => descriptor.harness !== "ci",
    )
      .map(buildBuiltinProvenanceAdapter)
      .sort((left, right) => left.harness.localeCompare(right.harness)),
  );

interface RegisteredAgentProvenanceAdapter {
  adapter: AgentProvenanceAdapter;
  registrations: number;
}

const registeredAgentProvenanceAdapters = new Map<
  string,
  RegisteredAgentProvenanceAdapter
>();

interface RegisteredHarnessSignalDescriptor {
  descriptor: NormalizedHarnessSignalDescriptor;
  registrations: number;
}

const registeredHarnessSignalDescriptors = new Map<
  string,
  RegisteredHarnessSignalDescriptor
>();

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
              entry[1] === "claude_session_file" ||
              entry[1] === "codex_session_file"),
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
  const adapterDescriptors = new Map(
    BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.filter(
      (descriptor) => descriptor.harness !== "ci",
    ).map((descriptor) => [
      descriptor.harness,
      normalizeHarnessSignalDescriptor(descriptor),
    ]),
  );
  for (const { adapter } of registeredAgentProvenanceAdapters.values()) {
    adapterDescriptors.set(
      adapter.harness,
      normalizeHarnessSignalDescriptor(adapter.descriptor),
    );
  }
  const descriptors = [
    ...adapterDescriptors.values(),
    ...NORMALIZED_BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.filter(
      (descriptor) => descriptor.harness === "ci",
    ),
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[_\s]+/gu, "-");
  return AGENT_ROLE_VALUES.has(normalized) ? normalized : undefined;
}

function boundedProvenanceValue(
  provenance: Readonly<Record<string, string | undefined>> | undefined,
  dimension: string,
): string | undefined {
  return nonBlank(provenance?.[dimension])?.slice(0, 256);
}

const MAX_PROVENANCE_PROBE_BYTES = 1_048_576;
const MAX_CODEX_PROVENANCE_PROBE_BYTES = 4_194_304;
const codexProvenanceSnapshotCache = new Map<
  string,
  Readonly<Record<string, string | undefined>>
>();
const EMPTY_CODEX_PROVENANCE_SNAPSHOT = Object.freeze({});
const claudeProvenanceSnapshotCache = new Map<
  string,
  Readonly<Record<string, string | undefined>>
>();
const EMPTY_CLAUDE_PROVENANCE_SNAPSHOT = Object.freeze({});

function asProvenanceRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseClaudeProvenanceLine(
  line: string,
): Readonly<Record<string, string | undefined>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return EMPTY_CLAUDE_PROVENANCE_SNAPSHOT;
  }
  const record = asProvenanceRecord(parsed);
  if (!record) return EMPTY_CLAUDE_PROVENANCE_SNAPSHOT;
  const queue: Array<{ value: Record<string, unknown>; depth: number }> = [
    { value: record, depth: 0 },
  ];
  let visited = 0;
  let model: string | undefined;
  let version: string | undefined;
  while (queue.length > 0 && visited < 64) {
    const current = queue.shift()!;
    visited += 1;
    model ??= nonBlank(current.value.model)?.slice(0, 256);
    version ??= nonBlank(current.value.version)?.slice(0, 256);
    if (model && version) break;
    if (current.depth >= 4) continue;
    for (const value of Object.values(current.value)) {
      const nested = asProvenanceRecord(value);
      if (nested) {
        queue.push({
          value: nested,
          depth: current.depth + 1,
        });
      }
    }
  }
  return Object.freeze({ model, version });
}

/** Classify one candidate without following symlinks or leaking filesystem detail. */
function claudeTranscriptCandidateStatus(
  candidate: string,
): "available" | "failed" | "missing" {
  try {
    return fs.lstatSync(candidate).isFile() ? "available" : "missing";
  } catch (error) {
    return isFileAbsentError(error) ? "missing" : "failed";
  }
}

/** Resolve one Claude transcript by stable session identity without exposing its path. */
function resolveClaudeSessionFile(
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
):
  | Readonly<{ status: "available"; path: string }>
  | Readonly<{
      status: "ambiguous" | "failed" | "missing" | "unavailable";
    }> {
  const session = nonBlank(env.CLAUDE_CODE_SESSION_ID);
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/u.test(session)) {
    return { status: "unavailable" };
  }
  const workspace = path.resolve(signals.cwd ?? process.cwd());
  const encodedWorkspace = workspace.replaceAll(/[^A-Za-z0-9-]/gu, "-");
  const projectsRoot = path.join(
    signals.home_dir ?? os.homedir(),
    ".claude",
    "projects",
  );
  const directPath = path.join(
    projectsRoot,
    encodedWorkspace,
    `${session}.jsonl`,
  );
  const explicitPath = nonBlank(signals.session_file);
  const suppliedPath =
    explicitPath && path.basename(explicitPath) === `${session}.jsonl`
      ? explicitPath
      : undefined;
  for (const candidate of [suppliedPath, directPath]) {
    if (!candidate) continue;
    const status = claudeTranscriptCandidateStatus(candidate);
    if (status === "available") return { status, path: candidate };
    if (status === "failed") return { status };
  }
  let matches: string[];
  try {
    matches = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 512)
      .flatMap((entry) => {
        const candidate = path.join(
          projectsRoot,
          entry.name,
          `${session}.jsonl`,
        );
        return claudeTranscriptCandidateStatus(candidate) === "available"
          ? [candidate]
          : [];
      });
  } catch (error) {
    return {
      status: isFileAbsentError(error) ? "missing" : "failed",
    };
  }
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "available", path: matches[0]! };
}

function readClaudeSessionProvenance(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const resolution = resolveClaudeSessionFile(signals, env);
  if (resolution.status !== "available") return undefined;
  try {
    const file = fs.openSync(
      resolution.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stats = fs.fstatSync(file);
      const cacheKey = `${resolution.path}\u0000${stats.size}\u0000${stats.mtimeMs}`;
      const cached = claudeProvenanceSnapshotCache.get(cacheKey);
      if (cached) return cached[dimension];
      const probeLength = Math.min(stats.size, MAX_PROVENANCE_PROBE_BYTES);
      const headLength = Math.min(probeLength, Math.ceil(probeLength / 2));
      const tailLength = Math.min(
        probeLength - headLength,
        stats.size - headLength,
      );
      const head = Buffer.alloc(headLength);
      fs.readSync(file, head, 0, headLength, 0);
      const tail = Buffer.alloc(tailLength);
      if (tailLength > 0) {
        fs.readSync(file, tail, 0, tailLength, stats.size - tailLength);
      }
      const snapshot: Record<string, string | undefined> = {};
      const lines =
        stats.size <= probeLength
          ? Buffer.concat([head, tail]).toString("utf8").split("\n")
          : [
              ...head.toString("utf8").split("\n").slice(0, 4_096),
              ...tail.toString("utf8").split("\n").slice(-4_096),
            ];
      for (const line of lines) {
        if (line.length === 0 || line.length > 262_144) continue;
        const parsed = parseClaudeProvenanceLine(line);
        snapshot.model ??= parsed.model;
        snapshot.version ??= parsed.version;
        if (snapshot.model && snapshot.version) break;
      }
      const frozen = Object.freeze(snapshot);
      claudeProvenanceSnapshotCache.clear();
      claudeProvenanceSnapshotCache.set(cacheKey, frozen);
      return frozen[dimension];
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return undefined;
  }
}

function findCodexSessionFile(
  root: string,
  session: string,
): string | undefined {
  let visited = 0;
  const visit = (directory: string, depth: number): string | undefined => {
    if (depth > 4 || visited >= 512) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => right.name.localeCompare(left.name));
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 512) return undefined;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(`-${session}.jsonl`)) {
        return entryPath;
      }
      if (entry.isDirectory()) {
        const found = visit(entryPath, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(root, 0);
}

function codexProvenanceWindows(
  size: number,
): ReadonlyArray<Readonly<{ offset: number; length: number }>> {
  if (size <= MAX_CODEX_PROVENANCE_PROBE_BYTES) {
    return [{ offset: 0, length: size }];
  }
  const halfBudget = Math.floor(MAX_CODEX_PROVENANCE_PROBE_BYTES / 2);
  return [
    { offset: size - halfBudget, length: halfBudget },
    { offset: 0, length: halfBudget },
  ];
}

function mergeCodexTurnContext(
  snapshot: Record<string, string | undefined>,
  line: string,
): void {
  if (line.length === 0 || line.length > 262_144) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "turn_context") return;
  const payload =
    typeof record.payload === "object" && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : undefined;
  snapshot.model ??= nonBlank(payload?.model)?.slice(0, 256);
  snapshot.effort ??= nonBlank(payload?.effort)?.slice(0, 256);
}

function readCodexProvenanceSnapshot(
  file: number,
  size: number,
): Readonly<Record<string, string | undefined>> {
  const snapshot: Record<string, string | undefined> = {};
  let linesRemaining = 4_096;
  for (const window of codexProvenanceWindows(size)) {
    const buffer = Buffer.alloc(window.length);
    fs.readSync(file, buffer, 0, window.length, window.offset);
    const lines = buffer
      .toString("utf8")
      .split("\n")
      .reverse()
      .slice(0, linesRemaining);
    linesRemaining -= lines.length;
    for (const line of lines) {
      mergeCodexTurnContext(snapshot, line);
      if (snapshot.model && snapshot.effort) break;
    }
    if ((snapshot.model && snapshot.effort) || linesRemaining <= 0) break;
  }
  return snapshot;
}

function readCodexSessionProvenance(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const session = nonBlank(env.CODEX_THREAD_ID);
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/u.test(session)) return undefined;
  const sessionsRoot = path.join(
    signals.home_dir ?? os.homedir(),
    ".codex",
    "sessions",
  );
  const cacheKey = `${sessionsRoot}\0${session}`;
  const cached = codexProvenanceSnapshotCache.get(cacheKey);
  if (cached) return cached[dimension];
  const sessionPath = findCodexSessionFile(sessionsRoot, session);
  if (!sessionPath) {
    codexProvenanceSnapshotCache.set(cacheKey, EMPTY_CODEX_PROVENANCE_SNAPSHOT);
    return undefined;
  }
  try {
    const file = fs.openSync(sessionPath, "r");
    try {
      const size = fs.fstatSync(file).size;
      const snapshot = readCodexProvenanceSnapshot(file, size);
      codexProvenanceSnapshotCache.set(cacheKey, snapshot);
      return snapshot[dimension];
    } finally {
      fs.closeSync(file);
    }
  } catch {
    codexProvenanceSnapshotCache.set(cacheKey, EMPTY_CODEX_PROVENANCE_SNAPSHOT);
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
  if (resolver === "codex_session_file") {
    return readCodexSessionProvenance(dimension, signals, env);
  }
  if (resolver === "ai_agent_version") {
    const value = nonBlank(env.AI_AGENT);
    if (
      !value ||
      !descriptor ||
      !literalSignalMatches(value, descriptor.harness)
    ) {
      return undefined;
    }
    const match =
      /(?:^|[@/\s])v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)$/u.exec(value);
    return match?.[1]?.slice(0, 256);
  }
  return undefined;
}

function provenanceResolverHasInput(
  resolver: AgentProvenanceResolver,
  descriptor: NormalizedHarnessSignalDescriptor,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
): "ambiguous" | "available" | "failed" | "missing" | "unavailable" {
  if (resolver === "ai_agent_version") {
    const value = nonBlank(env.AI_AGENT);
    return value !== undefined &&
      literalSignalMatches(value, descriptor.harness)
      ? "available"
      : "unavailable";
  }
  if (resolver === "codex_session_file") {
    return nonBlank(env.CODEX_THREAD_ID) !== undefined
      ? "available"
      : "unavailable";
  }
  return resolveClaudeSessionFile(signals, env).status;
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

function inferredProvenanceObservation(
  dimension: string,
  semanticAttribution: AgentSemanticAttribution | undefined,
): AgentProvenanceObservation | undefined {
  if (!semanticAttribution) return undefined;
  let value: string | undefined;
  if (dimension === "topic") value = semanticAttribution.topic;
  if (dimension === "role") value = semanticAttribution.role;
  if (!value) return undefined;
  return {
    value,
    source: "inferred",
    confidence: semanticAttribution.confidence,
    rule_version: semanticAttribution.rule_version,
    evidence: semanticAttribution.evidence,
  };
}

function firstProvenanceObservation(
  candidates: readonly (readonly [string | undefined, AgentModelSource])[],
): AgentProvenanceObservation | undefined {
  const observed = candidates.find(([value]) => value !== undefined);
  return observed?.[0]
    ? { value: observed[0], source: observed[1] }
    : undefined;
}

function resolveAgentProvenanceObservation(
  dimension: string,
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  sessionContext: AgentSessionContext | undefined,
  semanticAttribution: AgentSemanticAttribution | undefined,
): AgentProvenanceObservation | undefined {
  const overrideKey = `PM_AGENT_${dimension.toUpperCase().replaceAll("-", "_")}`;
  const hostResolvedDimensions = new Set([
    ...AGENT_PROVENANCE_DIMENSIONS,
    ...Object.keys(descriptor?.provenance_environment_keys ?? {}),
  ]);
  let overrideValue: string | undefined;
  let argvValue: string | undefined;
  let argvFlagValue: string | undefined;
  if (hostResolvedDimensions.has(dimension)) {
    overrideValue = normalizeProvenanceValue(
      dimension,
      nonBlank(env[overrideKey])?.slice(0, 256),
    );
    argvFlagValue = normalizeProvenanceValue(
      dimension,
      provenanceFlagValue(signals.argv ?? [], dimension),
    );
    argvValue = normalizeProvenanceValue(
      dimension,
      provenanceFromArgv(signals.argv ?? [], dimension),
    );
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
  const sessionValue = boundedProvenanceValue(
    sessionContext?.provenance,
    dimension,
  );
  const environmentValue = normalizeProvenanceValue(
    dimension,
    firstEnvironmentValue(env, environmentKeysByDimension[dimension]),
  );
  const clientValue = normalizeProvenanceValue(
    dimension,
    boundedProvenanceValue(clientProvenance, dimension),
  );
  const hostValue = normalizeProvenanceValue(
    dimension,
    boundedProvenanceValue(signals.provenance, dimension),
  );
  const probeValue = resolveProvenanceProbe(
    dimension,
    signals,
    env,
    descriptor,
  );
  const observed = firstProvenanceObservation([
    [overrideValue, "override"],
    [sessionValue, "session"],
    [argvFlagValue, "argv"],
    [environmentValue, "environment"],
    [clientValue, "mcp_client"],
    [hostValue, "host"],
    [probeValue, "probe"],
  ]);
  return (
    observed ??
    inferredProvenanceObservation(dimension, semanticAttribution) ??
    (argvValue ? { value: argvValue, source: "argv" } : undefined)
  );
}

function resolveAgentInstance(
  harness: string | undefined,
  session: string | undefined,
): string | undefined {
  if (!harness || !session) return undefined;
  return createHash("sha256")
    .update(`pm-agent-instance:v1\0${harness}\0${session}`)
    .digest("hex")
    .slice(0, 24);
}

function resolveAgentProvenance(
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  sessionContext: AgentSessionContext | undefined,
  semanticAttribution: AgentSemanticAttribution | undefined,
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
      semanticAttribution,
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

function normalizeAgentProvenanceAdapter(
  adapter: AgentProvenanceAdapter,
): AgentProvenanceAdapter {
  const descriptor = normalizeHarnessSignalDescriptor(adapter.descriptor);
  const harness = adapter.harness.trim().toLowerCase();
  if (adapter.contract_version !== 1) {
    throw new Error(
      `Unsupported provenance adapter contract for "${harness}": ${adapter.contract_version}`,
    );
  }
  if (descriptor.harness !== harness) {
    throw new Error(
      `Provenance adapter harness "${harness}" does not match descriptor "${descriptor.harness}".`,
    );
  }
  const adapterVersion = nonBlank(adapter.adapter_version)?.slice(0, 64);
  if (!adapterVersion) {
    throw new Error(`Provenance adapter "${harness}" requires a version.`);
  }
  if (!Number.isSafeInteger(adapter.priority)) {
    throw new Error(
      `Provenance adapter "${harness}" requires an integer priority.`,
    );
  }
  if (
    adapter.probe_policy.network_access !== false ||
    adapter.probe_policy.subprocess_access !== false ||
    adapter.probe_policy.max_bytes > MAX_CODEX_PROVENANCE_PROBE_BYTES ||
    adapter.probe_policy.max_lines > 4_096
  ) {
    throw new Error(
      `Provenance adapter "${harness}" exceeds the bounded local probe policy.`,
    );
  }
  return Object.freeze({
    ...adapter,
    adapter_version: adapterVersion,
    harness,
    descriptor,
    supported_dimensions: Object.freeze(
      boundedUniqueStrings(adapter.supported_dimensions)
        .map((dimension) => dimension.toLowerCase())
        .sort(),
    ),
    native_sources: Object.freeze([...new Set(adapter.native_sources)]),
    probe_policy: Object.freeze({ ...adapter.probe_policy }),
    normalization: Object.freeze({ ...adapter.normalization }),
    ...(adapter.waivers
      ? {
          waivers: Object.freeze(
            Object.fromEntries(
              Object.entries(adapter.waivers)
                .slice(0, 32)
                .map(([dimension, reason]) => [
                  dimension.slice(0, 64),
                  reason.slice(0, 256),
                ]),
            ),
          ),
        }
      : {}),
  });
}

/** Return the effective built-in or explicitly higher-priority package adapters. */
export function listAgentProvenanceAdapters(): readonly AgentProvenanceAdapter[] {
  const effective = new Map(
    BUILTIN_AGENT_PROVENANCE_ADAPTERS.map((adapter) => [
      adapter.harness,
      adapter,
    ]),
  );
  for (const { adapter } of registeredAgentProvenanceAdapters.values()) {
    effective.set(adapter.harness, adapter);
  }
  return Object.freeze(
    [...effective.values()].sort((left, right) =>
      left.harness.localeCompare(right.harness),
    ),
  );
}

/**
 * Register package adapters until disposal. Replacing a built-in requires an
 * explicitly greater priority; equal-priority ambiguity fails closed.
 */
export function registerAgentProvenanceAdapters(
  adapters: readonly AgentProvenanceAdapter[],
): () => void {
  const normalized = adapters.map(normalizeAgentProvenanceAdapter);
  const builtins = new Map(
    BUILTIN_AGENT_PROVENANCE_ADAPTERS.map((adapter) => [
      adapter.harness,
      adapter,
    ]),
  );
  const seen = new Set<string>();
  for (const adapter of normalized) {
    if (seen.has(adapter.harness)) {
      throw new Error(`Provenance adapter collision for "${adapter.harness}".`);
    }
    const builtin = builtins.get(adapter.harness);
    if (builtin && adapter.priority <= builtin.priority) {
      throw new Error(
        `Provenance adapter override for "${adapter.harness}" requires priority greater than ${builtin.priority}.`,
      );
    }
    const registered = registeredAgentProvenanceAdapters.get(adapter.harness);
    if (
      registered &&
      JSON.stringify(registered.adapter) !== JSON.stringify(adapter)
    ) {
      throw new Error(`Provenance adapter collision for "${adapter.harness}".`);
    }
    seen.add(adapter.harness);
  }
  for (const adapter of normalized) {
    const registered = registeredAgentProvenanceAdapters.get(adapter.harness);
    registeredAgentProvenanceAdapters.set(adapter.harness, {
      adapter,
      registrations: (registered?.registrations ?? 0) + 1,
    });
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const adapter of normalized) {
      const registered = registeredAgentProvenanceAdapters.get(adapter.harness);
      if (!registered || registered.registrations <= 1) {
        registeredAgentProvenanceAdapters.delete(adapter.harness);
      } else {
        registered.registrations -= 1;
      }
    }
  };
}

/** Normalize model-family or effort vocabulary while retaining the raw value. */
export function normalizeAgentProvenanceAdapterValue(
  dimension: "model" | "effort",
  value: string,
): NormalizedAgentProvenanceAdapterValue {
  const raw = value.trim().slice(0, 256);
  let normalized = raw.toLowerCase();
  if (dimension === "model") {
    const family = /^(gpt-\d+(?:\.\d+)?)/u.exec(normalized)?.[1];
    if (family) normalized = family;
  } else {
    normalized = normalized.replaceAll(/[_\s-]+/gu, "");
    const effortAliases: Readonly<Record<string, string>> = {
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
      ultra: "ultra",
    };
    normalized = effortAliases[normalized] ?? normalized;
  }
  return { raw, normalized, vocabulary: "v1" };
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
  const session = [
    firstEnvironmentValue(env, descriptor?.session_environment_keys),
    nonBlank(effectiveSignals.client_info?.session)?.slice(0, 256),
  ].find((candidate) => candidate !== undefined);
  const instance = resolveAgentInstance(descriptor?.harness, session);
  const semanticAttribution = readAgentSemanticAttributionSync({
    cwd: effectiveSignals.cwd ?? process.cwd(),
    env,
    key: instance,
  });
  const provenance = resolveAgentProvenance(
    effectiveSignals,
    env,
    descriptor,
    sessionContext,
    semanticAttribution,
  );
  const modelCandidate = provenance.model;
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

/** Classify one configured resolver's privacy-safe absence outcome. */
function provenanceResolverAbsence(
  resolverInput:
    | "ambiguous"
    | "available"
    | "failed"
    | "missing"
    | "unavailable",
): Pick<AgentProvenanceOutcome, "reason" | "status"> {
  if (resolverInput === "unavailable") {
    return { status: "unavailable", reason: "harness_unavailable" };
  }
  if (resolverInput === "missing") {
    return { status: "unavailable", reason: "resolver_input_missing" };
  }
  return { status: "failed", reason: "resolver_failed" };
}

function resolveProvenanceOutcome(
  dimension: string,
  identity: DetectedAgentIdentity,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
  signals: HarnessDetectionSignals,
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
    if (!probesEnabled) {
      return {
        status: "unavailable",
        reason: "probes_disabled",
        resolver,
        rule_version: "v1",
      };
    }
    const resolverInput = provenanceResolverHasInput(
      resolver,
      descriptor,
      signals,
      env,
    );
    return {
      ...provenanceResolverAbsence(resolverInput),
      resolver,
      rule_version: "v1",
    };
  }
  return {
    status: descriptor?.provenance_unavailable_dimensions.includes(dimension)
      ? "unavailable"
      : "not_configured",
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
    firstEnvironmentValue(env, descriptor?.provenance_environment_keys.role),
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
        effectiveSignals,
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
