import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeBulkIdsValue,
  parseBulkIdsText,
  resolveCliBulkIdsInput,
} from "../../../../src/core/io/bulk-ids-input.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("bulk ID input sources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses comma and line delimiters with stable deduplication", () => {
    expect(parseBulkIdsText(" pm-a,pm-b\npm-a\r\n\n pm-c ")).toEqual([
      "pm-a",
      "pm-b",
      "pm-c",
    ]);
    expect(normalizeBulkIdsValue(["pm-a,pm-b", "pm-a", "pm-c"])).toBe(
      "pm-a,pm-b,pm-c",
    );
    expect(normalizeBulkIdsValue(undefined)).toBeUndefined();
    expect(normalizeBulkIdsValue(" , \n ")).toBe("");
  });

  it("resolves stdin, @path, inline text, and an omitted selector", async () => {
    const seen: string[] = [];
    expect(
      await resolveCliBulkIdsInput("-", "--ids", {
        readStdin: async (optionName) => {
          seen.push(optionName);
          return "pm-a\npm-b";
        },
      }),
    ).toBe("pm-a,pm-b");
    expect(
      await resolveCliBulkIdsInput("  @ ids.txt ", "--ids", {
        readFile: async (path) => {
          seen.push(path);
          return "pm-b,pm-c";
        },
      }),
    ).toBe("pm-b,pm-c");
    expect(await resolveCliBulkIdsInput("pm-c\npm-d")).toBe("pm-c,pm-d");
    expect(await resolveCliBulkIdsInput(undefined)).toBeUndefined();
    expect(seen).toEqual(["--ids", "ids.txt"]);
  });

  it("uses the default stdin and file readers", async () => {
    const stdin = new PassThrough();
    stdin.end("pm-stdin-a\npm-stdin-b");
    Object.defineProperty(stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin as unknown as NodeJS.ReadStream & { fd: 0 },
    );
    await expect(resolveCliBulkIdsInput("-")).resolves.toBe(
      "pm-stdin-a,pm-stdin-b",
    );

    const dir = await mkdtemp(path.join(tmpdir(), "pm-bulk-ids-"));
    try {
      const file = path.join(dir, "ids.txt");
      await writeFile(file, "pm-file-a\npm-file-b", "utf8");
      await expect(resolveCliBulkIdsInput(`@${file}`)).resolves.toBe(
        "pm-file-a,pm-file-b",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wraps non-Error file failures and stdin reader failures", async () => {
    await expect(
      resolveCliBulkIdsInput("@broken", "--ids", {
        readFile: async () => {
          throw "string failure";
        },
      }),
    ).rejects.toThrow('could not read "broken": string failure');
    await expect(
      resolveCliBulkIdsInput("-", "--ids", {
        readStdin: async () => {
          throw new Error("stdin failure");
        },
      }),
    ).rejects.toThrow("could not read stdin: stdin failure");
  });

  it("fails closed for an empty @path, unreadable input, and empty content", async () => {
    await expect(resolveCliBulkIdsInput("@")).rejects.toMatchObject({
      context: expect.objectContaining({ code: "bulk_ids_input_missing_path" }),
    });
    await expect(
      resolveCliBulkIdsInput("@missing.txt", "--ids", {
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toMatchObject({
      exitCode: 3,
      context: expect.objectContaining({ code: "bulk_ids_input_unreadable" }),
    });
    await expect(
      resolveCliBulkIdsInput("-", "--ids", { readStdin: async () => "\n," }),
    ).rejects.toMatchObject({
      context: expect.objectContaining({ code: "bulk_ids_input_empty" }),
    });
    await expect(resolveCliBulkIdsInput("@")).rejects.toBeInstanceOf(
      PmCliError,
    );
  });
});
