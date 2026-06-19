import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * pm-i84i cross-platform regression guard.
 *
 * Invalid-type hints render the schema `types.json` location through
 * `filePathForSchemaSection`, which joins the active tracker root with the
 * configured (forward-slash) section path using `node:path`. On Windows that
 * must yield backslash separators (`.agents\pm\schema\types.json`); a hardcoded
 * forward-slash join would only surface in the `windows-latest` nightly suite.
 *
 * Simulating the win32 path module lets this assertion run on a POSIX per-PR
 * runner yet still fail if the separator handling regresses, so the guard is a
 * required check rather than nightly-only.
 */
describe("filePathForSchemaSection win32 separator guard (pm-i84i)", () => {
  afterEach(() => {
    vi.doUnmock("node:path");
    vi.resetModules();
  });

  it("joins a forward-slash schema section path with the win32 separator", async () => {
    vi.doMock("node:path", () => ({ default: path.win32, ...path.win32 }));
    const { filePathForSchemaSection } = await import("../../../../src/core/schema/runtime-schema.js");

    expect(filePathForSchemaSection("D:\\repo\\.agents\\pm", "schema/types.json", "schema/types.json")).toBe(
      "D:\\repo\\.agents\\pm\\schema\\types.json",
    );
  });

  it("returns an already-absolute win32 section path unchanged", async () => {
    vi.doMock("node:path", () => ({ default: path.win32, ...path.win32 }));
    const { filePathForSchemaSection } = await import("../../../../src/core/schema/runtime-schema.js");

    expect(filePathForSchemaSection("D:\\repo\\.agents\\pm", "E:\\custom\\types.json", "schema/types.json")).toBe(
      "E:\\custom\\types.json",
    );
  });
});
