/**
 * @module sdk/contracts
 *
 * Exposes command and action contract data without loading SDK runtime code.
 */
export * from "./cli-contracts.js";
export * from "./mcp/executable.js";
export * from "./graph/query-contracts.js";
export * from "./cli-contracts/grammar-contracts.js";
export * from "./cli-contracts/command-exit-contracts.js";
export * from "./context-intent-contracts.js";
export * from "./error-code-catalog.js";
export * from "./generated-error-code-catalog.js";
export * from "./flag-invocation-contracts.js";
export { resolveExtensionFlagValueContract, type ExtensionFlagValueContract } from "../core/extensions/flag-value-types.js";
export * from "./cli-contracts/flag-lexicon-contracts.js";
export * from "./output-token-accounting.js";
export * from "./output-contracts.js";
export * from "./agent/task-transcript-contracts.js";
export * from "./read-output-contracts.js";
export * from "./history/attestation-contract.js";
export * from "../core/history/operation-contract.js";
export * from "./agent/refusal-closure.js";
export * from "./agent/closed-domain-contracts.js";
export * from "./agent/tracker-preflight-contracts.js";
export type {
  PmReadOutputSessionReceipt,
  PmReadOutputSessionReference,
  PmReadOutputSessionState,
} from "./read-output-session.js";

// Types named by this entrypoint's exported function signatures, so consumers can import them (pm-gh1667).
export type { FlagDefinition } from "../core/extensions/extension-types.js";
export type { ContextIntentCursorEnvelope } from "./context-intent-contracts.js";
export type { ReadOutputResultForSession } from "./read-output-contracts.js";
