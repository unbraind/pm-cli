import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBodyFileContent } from "../../../../src/core/io/body-file.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

async function expectRejectionCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PmCliError);
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(PmCliError);
    expect((error as PmCliError).context.code).toBe(code);
  });
}

describe("resolveBodyFileContent (GH-214 --body-file)", () => {
  it("reads file content via an injected reader", async () => {
    const seen: string[] = [];
    const result = await resolveBodyFileContent("notes.md", undefined, async (p) => {
      seen.push(p);
      return "# Heading\n\nbody";
    });
    expect(result).toBe("# Heading\n\nbody");
    expect(seen).toEqual(["notes.md"]);
  });

  it("trims whitespace from the supplied path before reading", async () => {
    const result = await resolveBodyFileContent("  spec.md  ", undefined, async (p) => {
      expect(p).toBe("spec.md");
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("rejects when both --body and --body-file are provided", async () => {
    await expectRejectionCode(
      resolveBodyFileContent("spec.md", "inline body", async () => "unused"),
      "body_file_conflicts_with_body",
    );
  });

  it("treats an empty inline body string as provided (mutual exclusion still fires)", async () => {
    await expectRejectionCode(
      resolveBodyFileContent("spec.md", "", async () => "unused"),
      "body_file_conflicts_with_body",
    );
  });

  it("rejects an empty or whitespace-only path", async () => {
    await expectRejectionCode(
      resolveBodyFileContent("   ", undefined, async () => "unused"),
      "body_file_missing_path",
    );
  });

  it("wraps read failures in an actionable PmCliError", async () => {
    await expectRejectionCode(
      resolveBodyFileContent("missing.md", undefined, async () => {
        throw new Error("ENOENT");
      }),
      "body_file_unreadable",
    );
  });

  describe("default filesystem reader", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "pm-body-file-"));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads a real file from disk when no reader is injected", async () => {
      const file = path.join(dir, "body.md");
      await writeFile(file, "from disk", "utf8");
      expect(await resolveBodyFileContent(file, undefined)).toBe("from disk");
    });

    it("errors when the real file does not exist", async () => {
      await expectRejectionCode(resolveBodyFileContent(path.join(dir, "nope.md"), undefined), "body_file_unreadable");
    });
  });
});
