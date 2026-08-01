/**
 * @module sdk/core-governance
 *
 * Defines the shared agent-provenance and CLI-completeness governance surface
 * exposed by both the focused core entrypoint and the complete SDK barrel.
 */
export {
  AGENT_PROVENANCE_DIMENSIONS,
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  detectAgentIdentity,
  detectHarnessIdentity,
  readAuthorEnvironment,
  registerHarnessSignalDescriptors,
  resolveAuthorIdentity,
  runWithHarnessDetectionSignals,
  runWithWorkspaceHarnessSignalDescriptors,
  writeAuthorEnvironment,
  type AgentClientInfo,
  type AgentModelSource,
  type AgentProvenance,
  type AgentProvenanceObservation,
  type AuthorSource,
  type DetectedAgentIdentity,
  type HarnessDetectionSignals,
  type HarnessSignalDescriptor,
  type ResolvedAuthorIdentity,
} from "../core/shared/author.js";
export {
  analyzeAgentProvenanceDescriptorCoverage,
  groupHistoryByEpisode,
  resolveHistoryEpisodeGroupIdentity,
  summarizeAgentProvenance,
  summarizeAgentModelProvenance,
  type AgentEpisodeGroup,
  type AgentModelProvenanceCoverage,
  type AgentProvenanceDimensionCoverage,
  type AgentProvenanceDescriptorCoverage,
} from "./provenance.js";
export {
  analyzeSdkCliParameterCompleteness,
  type SdkCliActionParameterCoverage,
  type SdkCliCompletenessContractSource,
  type SdkCliParameterCoverageEntry,
  type SdkCliParameterDisposition,
} from "./cli-contracts.js";
