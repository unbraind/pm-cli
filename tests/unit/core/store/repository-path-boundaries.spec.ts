import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveImplicitPmRoot, resolvePmRoot } from "../../../../src/core/store/paths.js";

/** Build an outer tracker and an uninitialized inner repository without touching caller storage. */
function withRepositoryBoundary(run: (fixture: { outer: string; inner: string; alias: string; root: string }) => void): void {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pm-physical-boundary-")));
  try {
    const outer = path.join(root, ".agents", "pm");
    const inner = path.join(root, "vendor", "inner");
    const source = path.join(inner, "src");
    const alias = path.join(root, "alias");
    mkdirSync(outer, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(outer, "settings.json"), "{}");
    symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
    run({ outer, inner, alias, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each([false, true])("keeps directory aliases and missing descendants inside their physical repository (missing=%s)", (missing) => {
  withRepositoryBoundary(({ outer, inner, alias }) => {
    mkdirSync(path.join(inner, ".git"));
    const cwd = missing ? path.join(alias, "planned") : alias;
    expect(resolveImplicitPmRoot(cwd)).toBe(path.join(inner, ".agents", "pm"));
    expect(resolvePmRoot(cwd, outer)).toBe(outer);
    expect(readFileSync(path.join(outer, "settings.json"), "utf8")).toBe("{}");
  });
});

it.skipIf(process.platform === "win32")("propagates a looping .git lookup instead of adopting the outer tracker", () => {
  withRepositoryBoundary(({ outer, inner }) => {
    symlinkSync(".git", path.join(inner, ".git"));
    expect(() => resolveImplicitPmRoot(inner)).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(readFileSync(path.join(outer, "settings.json"), "utf8")).toBe("{}");
  });
});

it.skipIf(process.platform === "win32")("refuses a looping starting-directory alias before discovery", () => {
  withRepositoryBoundary(({ root }) => {
    const loop = path.join(root, "loop");
    symlinkSync("loop", loop);
    expect(() => resolveImplicitPmRoot(loop)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  });
});

it("retains absent-path fallback through the physical filesystem root", () => {
  const missing = path.join(path.parse(os.tmpdir()).root, "pm-discovery-absent-root-fixture");
  vi.stubEnv("PM_PATH", undefined);
  try {
    expect(resolvePmRoot(missing)).toBe(path.join(missing, ".agents", "pm"));
  } finally {
    vi.unstubAllEnvs();
  }
});
