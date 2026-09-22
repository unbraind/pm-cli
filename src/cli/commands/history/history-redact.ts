/**
 * @module cli/commands/history/history-redact
 *
 * Presentation compatibility shim for the public SDK history-redaction
 * primitive. CLI registration imports this module so extensions and existing
 * integrations keep a stable command path while all domain logic is SDK-owned.
 */
export {
  _testOnly,
  runHistoryRedact,
} from "../../../sdk/history-redact.js";
