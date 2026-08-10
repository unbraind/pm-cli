/**
 * @module sdk/core-governance
 *
 * Defines the shared agent-provenance and CLI-completeness governance surface
 * exposed by both the focused core entrypoint and the complete SDK barrel.
 */
export {
  AGENT_PROVENANCE_DIMENSIONS,
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
  diagnoseAgentIdentity,
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
  type AgentProvenanceAbsenceReason,
  type AgentProvenanceObservation,
  type AgentProvenanceOutcome,
  type AuthorSource,
  type DetectedAgentIdentity,
  type DiagnosedAgentIdentity,
  type HarnessDetectionSignals,
  type HarnessSignalDescriptor,
  type ResolvedAuthorIdentity,
} from "../core/shared/author.js";
export {
  SEMANTIC_ATTRIBUTION_LIMITS,
  recordClaimSemanticAttribution,
  recordFocusSemanticAttribution,
  recordReleaseSemanticAttribution,
  resolveSemanticLineageIds,
  semanticAttributionAffinity,
} from "./context/semantic-session-attribution.js";
export {
  explainSourceTraceability,
  parseSourceLineRange,
  type SourceDecisionPath,
  type SourceLineRange,
  type SourceTraceabilityEvidence,
  type SourceTraceabilityExplanation,
  type SourceTraceabilityRationale,
  type SourceTraceabilityReceipt,
} from "./traceability/source-traceability.js";
export {
  analyzeAgentProvenanceDescriptorCoverage,
  evaluateSemanticAttributionCoverage,
  groupHistoryByEpisode,
  resolveHistoryEpisodeGroupIdentity,
  summarizeAgentProvenance,
  summarizeAgentModelProvenance,
  type AgentEpisodeGroup,
  type AgentModelProvenanceCoverage,
  type AgentProvenanceDimensionCoverage,
  type AgentProvenanceDescriptorCoverage,
  type AgentSemanticAttributionCoverage,
  type AgentSemanticAttributionCoverageGate,
} from "./provenance.js";
export {
  analyzeSdkCliParameterCompleteness,
  type SdkCliActionParameterCoverage,
  type SdkCliCompletenessContractSource,
  type SdkCliParameterCoverageEntry,
  type SdkCliParameterDisposition,
} from "./cli-contracts.js";
