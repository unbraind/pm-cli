import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeItemTypeFolder,
  resolveItemTypeRegistry,
} from "../../../../src/core/item/type-registry.js";
import { normalizeAddTypeInput } from "../../../../src/core/schema/item-types-file.js";
import { ensureTypeFolderScaffold } from "../../../../src/sdk/schema.js";
import type { PmSettings } from "../../../../src/types/index.js";

describe("custom item-type folder containment", () => {
  it.each([
    ["custom/nested", "custom/nested"],
    ["/custom/nested", "custom/nested"],
    ["custom\\nested", "custom/nested"],
    ["custom/../nested", "nested"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(normalizeItemTypeFolder(input)).toBe(expected);
  });

  it.each([
    "../escape",
    "custom/../../escape",
    "C:\\escape",
    "/C:/escape",
    "/C:\\escape",
    "/custom/../C:/escape",
    "/",
    ".",
    "custom\0escape",
  ])("rejects folder %s when it cannot be confined", (folder) => {
    expect(() => normalizeItemTypeFolder(folder)).toThrow(
      "must stay inside the pm tracker root",
    );
  });

  it("rejects an extension-style definition before scaffolding outside the tracker", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-type-folder-scaffold-"),
    );
    const pmRoot = path.join(tempRoot, "tracker");
    const escapeTarget = path.join(tempRoot, "escaped-items");
    await mkdir(pmRoot);
    try {
      await expect(
        ensureTypeFolderScaffold(
          pmRoot,
          [{ name: "ExtensionReview", folder: "../escaped-items" }],
          [],
          "install:type-folder",
        ),
      ).rejects.toThrow("must stay inside the pm tracker root");
      await expect(access(escapeTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes explicit folders at schema authoring time", () => {
    expect(
      normalizeAddTypeInput({
        name: "Review",
        folder: " /custom/../reviews ",
      }),
    ).toMatchObject({ folder: "reviews" });
  });

  it("fails closed when a persisted runtime definition escapes the tracker", () => {
    const settings = {
      item_types: {
        definitions: [{ name: "Review", folder: "../../reviews" }],
      },
    } as PmSettings;

    expect(() => resolveItemTypeRegistry(settings)).toThrow(
      "must stay inside the pm tracker root",
    );
  });
});
