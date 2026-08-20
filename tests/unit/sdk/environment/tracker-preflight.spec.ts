import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import {
  assertInitializedTracker,
  assertReadableTrackerRoot,
  buildTrackerInitializationRecovery,
} from "../../../../src/sdk/environment/tracker-preflight.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pm-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("tracker preflight", () => {
  it("exposes a tokenized, shell-safe initialization recovery contract", () => {
    const trackerRoot = "/tmp/tracker with 'quotes'/$variables";

    expect(buildTrackerInitializationRecovery(trackerRoot)).toEqual({
      suggested_retry:
        "pm 'init' '/tmp/tracker with '\"'\"'quotes'\"'\"'/$variables' '--defaults' '--agent-guidance' 'skip'",
      suggested_retry_args: [
        "init",
        trackerRoot,
        "--defaults",
        "--agent-guidance",
        "skip",
      ],
    });
  });

  it("distinguishes a missing tracker root and emits executable initialization recovery", async () => {
    const parent = await createTemporaryRoot("missing-tracker");
    const trackerRoot = path.join(parent, "tracker");

    await expect(assertInitializedTracker(trackerRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
      code: "tracker_root_missing",
      context: {
        code: "tracker_root_missing",
        reason: "missing",
        resolved_path: trackerRoot,
        recovery: {
          suggested_retry_args: [
            "init",
            trackerRoot,
            "--defaults",
            "--agent-guidance",
            "skip",
          ],
        },
      },
    });
  });

  it("distinguishes an existing uninitialized directory", async () => {
    const trackerRoot = await createTemporaryRoot("empty-tracker");

    await expect(assertInitializedTracker(trackerRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
      code: "tracker_not_initialized",
      context: {
        code: "tracker_not_initialized",
        reason: "settings_missing",
        resolved_path: trackerRoot,
        recovery: {
          suggested_retry_args: [
            "init",
            trackerRoot,
            "--defaults",
            "--agent-guidance",
            "skip",
          ],
        },
      },
    });
  });

  it("rejects a regular-file tracker root without recommending pm init", async () => {
    const parent = await createTemporaryRoot("file-tracker");
    const trackerRoot = path.join(parent, "tracker.toon");
    await fs.writeFile(trackerRoot, "not a tracker\n", "utf8");

    let error: unknown;
    try {
      await assertInitializedTracker(trackerRoot);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PmCliError);
    expect(error).toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
      context: {
        code: "tracker_root_not_directory",
        reason: "not_a_directory",
        resolved_path: trackerRoot,
      },
    });
    expect((error as PmCliError).context.recovery).toBeUndefined();
    expect(JSON.stringify((error as PmCliError).context)).not.toContain(
      "pm init",
    );
  });

  it("rejects a missing descendant below a regular file as not a directory", async () => {
    const parent = await createTemporaryRoot("file-ancestor");
    const file = path.join(parent, "tracker-file");
    await fs.writeFile(file, "not a directory\n", "utf8");

    await expect(
      assertReadableTrackerRoot(path.join(file, "nested")),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      code: "tracker_root_not_directory",
    });
  });

  it("allows readable empty roots for metadata enumeration and initialized roots for commands", async () => {
    const trackerRoot = await createTemporaryRoot("valid-tracker");
    await expect(assertReadableTrackerRoot(trackerRoot)).resolves.toBeUndefined();
    await fs.writeFile(
      path.join(trackerRoot, "settings.json"),
      '{"id_prefix":"pm-"}\n',
      "utf8",
    );
    await expect(assertInitializedTracker(trackerRoot)).resolves.toBeUndefined();
  });
});
