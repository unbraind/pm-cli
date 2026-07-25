/**
 * @module core/shared/author
 *
 * Provides shared primitives and utilities for Author.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Stable provenance categories recorded beside newly appended history authors. */
export type AuthorSource = "asserted" | "configured" | "detected" | "unknown";

/** Stable source categories for model observations recorded in mutation history. */
export type AgentModelSource =
  | "override"
  | "environment"
  | "mcp_client"
  | "argv";

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
  /** Invocation/session identifier retained in local history only. */
  session?: string;
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
  /** Invocation-local descriptors appended after built-in and package signals. */
  descriptors?: readonly HarnessSignalDescriptor[];
}

const authorIdentityStorage = new AsyncLocalStorage<ResolvedAuthorIdentity>();
const harnessDetectionStorage =
  new AsyncLocalStorage<HarnessDetectionSignals>();
const workspaceHarnessSignalsStorage =
  new AsyncLocalStorage<readonly HarnessSignalDescriptor[]>();

/** Built-in agent descriptors evaluated before package and workspace additions. */
export const BUILTIN_HARNESS_SIGNAL_DESCRIPTORS: readonly HarnessSignalDescriptor[] =
  [
    {
      harness: "claude-code",
      environment_keys: ["CLAUDE_CODE", "CLAUDECODE"],
      model_environment_keys: ["ANTHROPIC_MODEL", "CLAUDE_MODEL"],
      session_environment_keys: ["CLAUDE_CODE_SESSION_ID"],
      argv_markers: ["claude", "claude-code"],
      client_names: ["claude", "claude-code", "claude code"],
    },
    {
      harness: "codex",
      environment_keys: ["CODEX_HOME", "CODEX_CI", "CODEX_THREAD_ID"],
      model_environment_keys: ["CODEX_MODEL"],
      session_environment_keys: ["CODEX_THREAD_ID"],
      argv_markers: ["codex"],
      client_names: ["codex"],
    },
    {
      harness: "pi",
      environment_keys: ["PI_AGENT", "PI_CODING_AGENT"],
      model_environment_keys: ["PI_MODEL"],
      session_environment_keys: ["PI_SESSION_ID"],
      argv_markers: ["pi"],
      client_names: ["pi"],
    },
    {
      harness: "opencode",
      environment_keys: ["OPENCODE", "OPENCODE_SESSION_ID"],
      model_environment_keys: ["OPENCODE_MODEL"],
      session_environment_keys: ["OPENCODE_SESSION_ID"],
      argv_markers: ["opencode"],
      client_names: ["opencode"],
    },
    {
      harness: "cursor",
      environment_keys: ["CURSOR_AGENT", "CURSOR_TRACE_ID"],
      model_environment_keys: ["CURSOR_MODEL"],
      session_environment_keys: ["CURSOR_TRACE_ID"],
      argv_markers: ["cursor"],
      client_names: ["cursor"],
    },
    {
      harness: "aider",
      environment_keys: ["AIDER", "AIDER_MODEL"],
      model_environment_keys: ["AIDER_MODEL"],
      session_environment_keys: ["AIDER_SESSION_ID"],
      argv_markers: ["aider"],
      client_names: ["aider"],
    },
    {
      harness: "gemini-cli",
      environment_keys: ["GEMINI_CLI", "GEMINI_CLI_HOME"],
      model_environment_keys: ["GEMINI_MODEL"],
      session_environment_keys: ["GEMINI_CLI_SESSION_ID"],
      argv_markers: ["gemini", "gemini-cli"],
      client_names: ["gemini", "gemini-cli", "gemini cli"],
    },
    {
      harness: "ci",
      environment_keys: ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"],
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

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function boundedUniqueStrings(
  values: readonly string[] | undefined,
): string[] {
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
    argv_markers: boundedUniqueStrings(descriptor.argv_markers).map((value) =>
      value.toLowerCase(),
    ),
    client_names: boundedUniqueStrings(descriptor.client_names).map((value) =>
      value.toLowerCase(),
    ),
  };
}

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
    ...BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
    ...[...registeredHarnessSignalDescriptors.values()].map(
      (entry) => entry.descriptor,
    ),
    ...(workspaceHarnessSignalsStorage.getStore() ?? []),
    ...localDescriptors,
  ].map(normalizeHarnessSignalDescriptor);
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

function modelFromArgv(argv: readonly string[]): string | undefined {
  const tokens = argv.slice(0, 3);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.slice(0, 512);
    if (token === "--model") {
      return nonBlank(tokens[index + 1])?.slice(0, 256);
    }
    if (token.startsWith("--model=")) {
      return nonBlank(token.slice("--model=".length))?.slice(0, 256);
    }
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
      argv: [process.execPath, ...process.argv],
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
    labels.some((label) => literalSignalMatches(label, marker)),
  );
  const clientMatch = descriptor.client_names.some(
    (name) => clientName === name || literalSignalMatches(clientName, name),
  );
  return environmentMatch || argvMatch || clientMatch;
}

function resolveAgentModel(
  signals: HarnessDetectionSignals,
  env: Readonly<Record<string, string | undefined>>,
  descriptor: NormalizedHarnessSignalDescriptor | undefined,
): { value: string; source: AgentModelSource } | undefined {
  const candidates: Array<{
    value: string | undefined;
    source: AgentModelSource;
  }> = [
    {
      value: nonBlank(env.PM_AGENT_MODEL)?.slice(0, 256),
      source: "override",
    },
    {
      value: firstEnvironmentValue(
        env,
        descriptor?.model_environment_keys,
      ),
      source: "environment",
    },
    {
      value: nonBlank(signals.client_info?.model)?.slice(0, 256),
      source: "mcp_client",
    },
    {
      value: modelFromArgv(signals.argv ?? []),
      source: "argv",
    },
  ];
  return candidates.find(
    (
      candidate,
    ): candidate is { value: string; source: AgentModelSource } =>
      candidate.value !== undefined,
  );
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
    BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.map((descriptor) => [
      descriptor.harness,
      normalizeHarnessSignalDescriptor(descriptor),
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
): T {
  const normalized = descriptors.map(normalizeHarnessSignalDescriptor);
  currentHarnessSignalDescriptors(normalized);
  return workspaceHarnessSignalsStorage.run(normalized, callback);
}

/**
 * Detect structured agent provenance from bounded caller-supplied signals.
 *
 * The function is deterministic and side-effect free. Descriptor values are
 * treated as literal strings; they never execute regexes, commands, filesystem
 * traversal, or network requests.
 */
export function detectAgentIdentity(
  signals: HarnessDetectionSignals = {},
): DetectedAgentIdentity {
  const env = signals.env ?? {};
  const descriptors = currentHarnessSignalDescriptors(signals.descriptors);
  const labels = [
    ...(signals.argv ?? []).slice(0, 3),
    ...(signals.process_labels ?? []),
  ]
    .slice(0, 64)
    .map((token) => token.slice(0, 512));
  const clientName = signals.client_info?.name.trim().toLowerCase() ?? "";
  const descriptor = descriptors.find((candidate) =>
    descriptorMatchesSignals(candidate, env, labels, clientName),
  );
  const modelCandidate = resolveAgentModel(signals, env, descriptor);
  const session =
    firstEnvironmentValue(env, descriptor?.session_environment_keys) ??
    nonBlank(signals.client_info?.session)?.slice(0, 256);
  const entries: Array<
    [keyof DetectedAgentIdentity, string | undefined]
  > = [
    ["harness", descriptor?.harness],
    ["model", modelCandidate?.value],
    ["model_source", modelCandidate?.source],
    ["session", session],
  ];
  return Object.fromEntries(
    entries.filter((entry) => entry[1] !== undefined),
  ) as DetectedAgentIdentity;
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
  signals: HarnessDetectionSignals = {},
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
  };
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
