import crypto from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { generateItemId, normalizeItemId, normalizePrefix } from "../../src/core/item/id.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("id generation and normalization", () => {
  it("normalizes prefixes and ids deterministically", () => {
    expect(normalizePrefix(undefined)).toBe("pm-");
    expect(normalizePrefix(" PM ")).toBe("pm-");
    expect(normalizePrefix("task")).toBe("task-");
    expect(normalizePrefix("task-")).toBe("task-");

    expect(normalizeItemId("#A1", "pm-")).toBe("pm-a1");
    expect(normalizeItemId("pm-A1", "pm-")).toBe("pm-a1");
    expect(normalizeItemId("A1", "pm-")).toBe("pm-a1");
  });

  it("generates 4-character tokens by default", async () => {
    const randomBytesSpy = vi
      .spyOn(crypto, "randomBytes")
      .mockImplementation((size: number) => Buffer.from([0, 1, 2, 3].slice(0, size)));

    try {
      await withTempPmPath(async (context) => {
        const id = await generateItemId(context.pmPath, "PM");
        expect(id).toBe("pm-0123");
        expect(id).toMatch(/^pm-[a-z0-9]{4}$/);
      });
    } finally {
      randomBytesSpy.mockRestore();
    }
  });

  it("retries when an id already exists", async () => {
    let invocation = 0;
    const randomBytesSpy = vi.spyOn(crypto, "randomBytes").mockImplementation((size: number) => {
      const fill = Math.min(invocation, 35);
      invocation += 1;
      return Buffer.alloc(size, fill);
    });

    try {
      await withTempPmPath(async (context) => {
        await writeFile(path.join(context.pmPath, "tasks", "pm-0000.md"), "{}\n\n", "utf8");
        const id = await generateItemId(context.pmPath, "pm-");
        expect(id).toBe("pm-1111");
      });
    } finally {
      randomBytesSpy.mockRestore();
    }
  });

  it("throws after bounded attempts when every candidate collides", async () => {
    const randomBytesSpy = vi.spyOn(crypto, "randomBytes").mockImplementation((size: number) => Buffer.alloc(size, 0));

    try {
      await withTempPmPath(async (context) => {
        for (let length = 4; length <= 10; length += 1) {
          const candidate = `pm-${"0".repeat(length)}`;
          await writeFile(path.join(context.pmPath, "tasks", `${candidate}.md`), "{}\n\n", "utf8");
        }

        await expect(generateItemId(context.pmPath, "pm-")).rejects.toThrow(
          "Unable to generate unique id after 224 attempts",
        );
      });
    } finally {
      randomBytesSpy.mockRestore();
    }
  });
});
