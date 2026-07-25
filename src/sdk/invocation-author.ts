/**
 * @module sdk/invocation-author
 *
 * Safely scopes invocation-wide mutation authors for one-shot and embedded CLI hosts.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  readAuthorEnvironment,
  writeAuthorEnvironment,
} from "../core/shared/author.js";

/** Apply an optional author override and return an idempotent environment restorer. */
export function applyInvocationAuthorOverride(
  author: string | undefined,
): () => void {
  if (author === undefined) {
    return () => {};
  }
  const normalizedAuthor = author.trim();
  if (normalizedAuthor.length === 0) {
    throw new PmCliError(
      "--author requires a non-empty value.",
      EXIT_CODE.USAGE,
      {
        code: "missing_required_argument",
        nextSteps: ["Pass an explicit author identifier with --author <id>."],
      },
    );
  }
  const previousAuthor = readAuthorEnvironment();
  writeAuthorEnvironment(normalizedAuthor);
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (previousAuthor === undefined) {
      writeAuthorEnvironment(undefined);
    } else {
      writeAuthorEnvironment(previousAuthor);
    }
  };
}
