/**
 * @module sdk/agent-session-context
 *
 * Public SDK entrypoint for session-scoped provenance and episode identity.
 */
export {
  agentSessionEnvironment,
  boundAgentEpisodeIdentity,
  runWithAgentSessionContext,
  resolveAgentSessionContextFromSignals,
  type AgentEpisodeIdentity,
  type AgentSessionContext,
} from "../core/shared/agent-session-context.js";
