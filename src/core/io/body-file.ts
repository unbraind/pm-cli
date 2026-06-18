/**
 * @module core/io/body-file
 *
 * Reads command body content from files, stdin, and inline arguments.
 */
import { readFile } from "node:fs/promises";

import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/**
 * GH-214: shared resolver for the `--body-file <path>` input convenience on
 * `pm create` and `pm update`. It loads a long markdown body from a file so
 * agents do not have to escape multi-paragraph content (code blocks, tables)
 * into a single inline `--body` string or issue a second `pm append` call.
 *
 * This is a CLI-only input alias that maps onto the existing `body` field, so
 * it deliberately does NOT flow through the MCP/contract field surface (a file
 * path is meaningless over MCP, mirroring `pm history --diff`). The file read is
 * injectable so the pure resolution logic stays fully unit-coverable without
 * touching disk.
 */
export type BodyFileReader = (path: string) => Promise<string>;

const defaultBodyFileReader: BodyFileReader = (path) => readFile(path, "utf8");

/**
 * Implements resolve body file content for the public runtime surface of this module.
 */
export async function resolveBodyFileContent(
  bodyFile: string,
  inlineBody: string | undefined,
  readFileImpl: BodyFileReader = defaultBodyFileReader,
): Promise<string> {
  // Mutual exclusion: --body and --body-file both define the body, so accepting
  // both silently would hide which one wins. Fail with an actionable message.
  if (inlineBody !== undefined) {
    throw new PmCliError(
      "--body and --body-file are mutually exclusive; provide the body inline with --body or from a file with --body-file, not both.",
      EXIT_CODE.USAGE,
      {
        code: "body_file_conflicts_with_body",
        required: "Choose exactly one body source.",
        why: "Both --body and --body-file set the item body; allowing both would make the effective body ambiguous.",
        nextSteps: ["Re-run with only --body <text> or only --body-file <path>."],
      },
    );
  }
  const path = bodyFile.trim();
  if (path.length === 0) {
    throw new PmCliError("--body-file requires a file path.", EXIT_CODE.USAGE, {
      code: "body_file_missing_path",
      required: "Pass a readable file path: --body-file <path>.",
      why: "An empty --body-file value has no file to read the body from.",
    });
  }
  try {
    return await readFileImpl(path);
  } catch (error: unknown) {
    // Preserve the underlying errno (ENOENT/EACCES/EISDIR/...) so the failure
    // is debuggable, and tailor the directory case (a real footgun: pointing
    // --body-file at a folder) to an exact message instead of a generic one.
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    const isDirectory = errno === "EISDIR";
    const detail = errno ? ` (${errno})` : "";
    throw new PmCliError(
      isDirectory
        ? `--body-file "${path}" is a directory, not a file. Point it at a readable file.`
        : `--body-file could not read "${path}"${detail}. Check that the file exists and is readable.`,
      EXIT_CODE.NOT_FOUND,
      {
        code: "body_file_unreadable",
        required: "Point --body-file at an existing, readable file.",
        why: `The body content is loaded from the file at the supplied path, so an unreadable path cannot produce a body${errno ? ` (underlying error: ${errno})` : ""}.`,
        nextSteps: [`Verify the path: ls -l "${path}"`, "Or pass the body inline with --body <text>."],
      },
    );
  }
}
