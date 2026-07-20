/**
 * @module sdk/runtime-primitives
 *
 * Exposes shared runtime primitives needed by CLI, MCP, and package adapters without private core imports.
 */
export {
  createStdinTokenResolver,
  type StdinTokenResolver,
} from "../core/item/parse.js";
export { resolveAuthor } from "../core/shared/author.js";
export { EXIT_CODE } from "../core/shared/constants.js";
export { PmCliError } from "../core/shared/errors.js";
export { resolvePmRoot } from "../core/store/paths.js";
