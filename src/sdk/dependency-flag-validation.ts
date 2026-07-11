/** @module cli/commands/dependency-flag-validation */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** Reject malformed shorthand before item-id prefix normalization can create a dangling graph node. */
export function assertValidBareDependencyFlagValue(
  value: string,
  structured: boolean,
): void {
  if (!structured && /[:,=]/.test(value)) {
    throw new PmCliError(
      `Invalid --dep value "${value}". Use a bare item id or id=<id>,kind=<kind>.`,
      EXIT_CODE.USAGE,
    );
  }
}
