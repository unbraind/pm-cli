/**
 * @module cli/public
 *
 * Publishes the supported embeddable CLI entrypoint without exposing the
 * implementation module's repository-only test seams to package consumers.
 */
export { runPmCli } from "./main.js";
