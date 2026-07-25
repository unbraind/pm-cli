/**
 * @module core/shared/author
 *
 * Provides shared primitives and utilities for Author.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Stable provenance categories recorded beside newly appended history authors. */
export type AuthorSource = "asserted" | "configured" | "detected" | "unknown";

/** Public, privacy-safe identity resolution result shared by CLI and SDK hosts. */
export interface ResolvedAuthorIdentity {
  /** Stable author value written to mutation history. */
  author: string;
  /** How the effective author was selected. */
  source: AuthorSource;
  /** Normalized harness namespace when automatic detection succeeded. */
  harness?: string;
}

/** Bounded runtime signals accepted by the pure harness detector. */
export interface HarnessDetectionSignals {
  /** Environment names and values supplied by the embedding runtime. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Executable and argument tokens for the current process. */
  argv?: readonly string[];
  /** Optional parent-process labels supplied by a host that already knows them. */
  process_labels?: readonly string[];
}

const authorIdentityStorage = new AsyncLocalStorage<ResolvedAuthorIdentity>();
const HARNESS_ENV_MARKERS: ReadonlyArray<{
  harness: string;
  keys: readonly string[];
}> = [
  { harness: "claude-code", keys: ["CLAUDE_CODE", "CLAUDECODE"] },
  { harness: "codex", keys: ["CODEX_HOME", "CODEX_CI", "CODEX_THREAD_ID"] },
  { harness: "pi", keys: ["PI_AGENT", "PI_CODING_AGENT"] },
  { harness: "opencode", keys: ["OPENCODE", "OPENCODE_SESSION_ID"] },
  { harness: "cursor", keys: ["CURSOR_AGENT", "CURSOR_TRACE_ID"] },
  { harness: "aider", keys: ["AIDER", "AIDER_MODEL"] },
  { harness: "gemini-cli", keys: ["GEMINI_CLI", "GEMINI_CLI_HOME"] },
];
const HARNESS_TOKEN_MARKERS: ReadonlyArray<{
  harness: string;
  pattern: RegExp;
}> = [
  { harness: "claude-code", pattern: /(?:^|[/\\\s])claude(?:$|[/\\\s])/iu },
  { harness: "codex", pattern: /(?:^|[/\\\s])codex(?:$|[/\\\s])/iu },
  { harness: "opencode", pattern: /(?:^|[/\\\s])opencode(?:$|[/\\\s])/iu },
  { harness: "cursor", pattern: /(?:^|[/\\\s])cursor(?:$|[/\\\s])/iu },
  { harness: "aider", pattern: /(?:^|[/\\\s])aider(?:$|[/\\\s])/iu },
  {
    harness: "gemini-cli",
    pattern: /(?:^|[/\\\s])gemini(?:-cli)?(?:$|[/\\\s])/iu,
  },
  { harness: "pi", pattern: /(?:^|[/\\\s])pi(?:$|[/\\\s])/iu },
];

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
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
  const env = signals.env ?? {};
  for (const marker of HARNESS_ENV_MARKERS) {
    if (marker.keys.some((key) => nonBlank(env[key]) !== undefined)) {
      return marker.harness;
    }
  }
  const labels = [...(signals.argv ?? []), ...(signals.process_labels ?? [])]
    .slice(0, 64)
    .map((token) => token.slice(0, 512));
  for (const marker of HARNESS_TOKEN_MARKERS) {
    if (labels.some((token) => marker.pattern.test(token))) {
      return marker.harness;
    }
  }
  if (
    nonBlank(env.CI) !== undefined ||
    nonBlank(env.GITHUB_ACTIONS) !== undefined ||
    nonBlank(env.BUILDKITE) !== undefined ||
    nonBlank(env.GITLAB_CI) !== undefined
  ) {
    return "ci";
  }
  return undefined;
}

/**
 * Resolve one mutation identity using the stable precedence contract:
 * explicit argument, `PM_AUTHOR`, configured default, detected harness, then
 * anonymous fallback.
 */
export function resolveAuthorIdentity(
  candidate: string | undefined,
  fallback: string | undefined,
  signals: HarnessDetectionSignals = {
    env: process.env,
    argv: [process.execPath, ...process.argv],
  },
): ResolvedAuthorIdentity {
  if (candidate !== undefined) {
    const explicit = nonBlank(candidate);
    return explicit
      ? { author: explicit, source: "asserted" }
      : { author: "unknown", source: "unknown" };
  }
  if (signals.env?.PM_AUTHOR !== undefined) {
    const environment = nonBlank(signals.env.PM_AUTHOR);
    return environment
      ? { author: environment, source: "asserted" }
      : { author: "unknown", source: "unknown" };
  }
  const configured = nonBlank(fallback);
  if (configured) {
    return { author: configured, source: "configured" };
  }
  const harness = detectHarnessIdentity(signals);
  if (harness) {
    return {
      author: `harness:${harness}`,
      source: "detected",
      harness,
    };
  }
  return { author: "unknown", source: "unknown" };
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

/** Resolves the effective mutation author from explicit input, environment defaults, and fallback settings. */
export function resolveAuthor(
  candidate: string | undefined,
  fallback: string,
): string {
  const identity = resolveAuthorIdentity(candidate, fallback);
  authorIdentityStorage.enterWith(identity);
  return identity.author;
}
