/**
 * @module core/shared/agent-session-context
 *
 * Defines privacy-bounded session and episode context shared by SDK, CLI, and
 * MCP hosts without making the context load-bearing for mutation correctness.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Stable identity for one declared agent episode and its optional parent. */
export interface AgentEpisodeIdentity {
  /** Stable caller-declared join key. */
  id: string;
  /** Human-readable purpose retained in local history. */
  label?: string;
  /** Stable parent episode key for delegated or nested work. */
  parent_id?: string;
}

/** Session-wide descriptive context inherited by subsequent mutations. */
export interface AgentSessionContext {
  /** Session-scoped role and topic declarations. */
  provenance?: Readonly<Record<string, string | undefined>>;
  /** Optional declared episode identity. */
  episode?: AgentEpisodeIdentity;
}

const agentSessionContextStorage = new AsyncLocalStorage<AgentSessionContext>();
const EPISODE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

function boundedText(value: unknown, limit: number): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed.slice(0, limit) : undefined;
}

/** Bound and validate an episode declaration without exposing raw input. */
export function boundAgentEpisodeIdentity(
  value: unknown,
  strict: boolean,
): AgentEpisodeIdentity | undefined {
  if (value === undefined) return undefined;
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const id = boundedText(record.id, 128);
  const parentId = boundedText(record.parent_id, 128);
  if (
    id === undefined ||
    !EPISODE_ID_PATTERN.test(id) ||
    (parentId !== undefined && !EPISODE_ID_PATTERN.test(parentId))
  ) {
    if (strict) {
      throw new Error(
        "Agent episode ids must be 1-128 letters, digits, dots, underscores, colons, or hyphens.",
      );
    }
    return undefined;
  }
  const label = boundedText(record.label, 256);
  return {
    id,
    ...(label === undefined ? {} : { label }),
    ...(parentId === undefined ? {} : { parent_id: parentId }),
  };
}

function normalizedProvenance(
  value: AgentSessionContext["provenance"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value ?? {}).slice(0, 32)) {
    const normalizedKey = key.trim().toLowerCase().slice(0, 64);
    const normalizedValue = boundedText(rawValue, 256);
    if (
      /^[a-z][a-z0-9_-]{0,63}$/u.test(normalizedKey) &&
      normalizedValue !== undefined
    ) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

/** Resolve ambient, inherited-environment, and explicit session context. */
export function resolveAgentSessionContext(
  explicit: AgentSessionContext | undefined,
  env: Readonly<Record<string, string | undefined>>,
  fallbackEpisode?: AgentEpisodeIdentity,
): AgentSessionContext | undefined {
  const ambient = agentSessionContextStorage.getStore();
  const environmentProvenance = normalizedProvenance({
    role: env.PM_AGENT_SESSION_ROLE,
    topic: env.PM_AGENT_SESSION_TOPIC,
  });
  const environmentEpisode = boundAgentEpisodeIdentity(
    env.PM_AGENT_EPISODE_ID === undefined
      ? undefined
      : {
          id: env.PM_AGENT_EPISODE_ID,
          label: env.PM_AGENT_EPISODE_LABEL,
          parent_id: env.PM_AGENT_EPISODE_PARENT_ID,
        },
    false,
  );
  const provenance = {
    ...normalizedProvenance(ambient?.provenance),
    ...environmentProvenance,
    ...normalizedProvenance(explicit?.provenance),
  };
  const episode =
    boundAgentEpisodeIdentity(explicit?.episode, false) ??
    boundAgentEpisodeIdentity(fallbackEpisode, false) ??
    environmentEpisode ??
    boundAgentEpisodeIdentity(ambient?.episode, false);
  return Object.keys(provenance).length === 0 && episode === undefined
    ? undefined
    : {
        ...(Object.keys(provenance).length === 0 ? {} : { provenance }),
        ...(episode === undefined ? {} : { episode }),
      };
}

/** Resolve session context from a complete embedded-host signal envelope. */
export function resolveAgentSessionContextFromSignals(
  signals: {
    session_context?: AgentSessionContext;
    client_info?: { episode?: AgentEpisodeIdentity };
  },
  env: Readonly<Record<string, string | undefined>>,
): AgentSessionContext {
  return (
    resolveAgentSessionContext(
      signals.session_context,
      env,
      signals.client_info?.episode,
    ) ?? {}
  );
}

/** Run work with one inherited session declaration and automatic episode nesting. */
export function runWithAgentSessionContext<T>(
  context: AgentSessionContext,
  callback: () => T,
): T {
  const ambient = agentSessionContextStorage.getStore();
  const episode = boundAgentEpisodeIdentity(context.episode, true);
  const parentEpisode = boundAgentEpisodeIdentity(ambient?.episode, false);
  const nestedEpisode =
    episode !== undefined &&
    episode.parent_id === undefined &&
    parentEpisode !== undefined
      ? { ...episode, parent_id: parentEpisode.id }
      : episode;
  const provenance = {
    ...normalizedProvenance(ambient?.provenance),
    ...normalizedProvenance(context.provenance),
  };
  return agentSessionContextStorage.run(
    {
      ...(Object.keys(provenance).length === 0 ? {} : { provenance }),
      ...(nestedEpisode === undefined
        ? parentEpisode === undefined
          ? {}
          : { episode: parentEpisode }
        : { episode: nestedEpisode }),
    },
    callback,
  );
}

/** Serialize one declaration into environment values inherited by CLI children. */
export function agentSessionEnvironment(
  context: AgentSessionContext,
): Record<string, string> {
  const provenance = normalizedProvenance(context.provenance);
  const episode = boundAgentEpisodeIdentity(context.episode, true);
  return {
    ...(episode === undefined
      ? {}
      : {
          PM_AGENT_EPISODE_ID: episode.id,
          ...(episode.label === undefined
            ? {}
            : { PM_AGENT_EPISODE_LABEL: episode.label }),
          ...(episode.parent_id === undefined
            ? {}
            : { PM_AGENT_EPISODE_PARENT_ID: episode.parent_id }),
        }),
    ...(provenance.role === undefined
      ? {}
      : { PM_AGENT_SESSION_ROLE: provenance.role }),
    ...(provenance.topic === undefined
      ? {}
      : { PM_AGENT_SESSION_TOPIC: provenance.topic }),
  };
}
