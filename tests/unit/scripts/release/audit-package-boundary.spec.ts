import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findAuditBoundaryViolations,
  loadBareCoreBoundarySources,
  main,
  runIfMain,
} from "../../../../scripts/release/audit-package-boundary.mjs";

describe("audit package boundary gate", () => {
  it("rejects executable audit surface while permitting history prose", () => {
    expect(
      findAuditBoundaryViolations([
        {
          path: "src/example.ts",
          text: "const option = '--allow-audit-update';\nconst service = 'linked_artifact_audit';",
        },
      ]),
    ).toEqual([
      { path: "src/example.ts", line: 1, token: "--allow-audit-update" },
      { path: "src/example.ts", line: 2, token: "linked_artifact_audit" },
    ]);
    expect(
      findAuditBoundaryViolations([
        { path: "src/history.ts", text: "Append an auditable history marker." },
      ]),
    ).toEqual([]);
  });

  it("keeps the checked-in bare-core boundary clean", () => {
    expect(findAuditBoundaryViolations(loadBareCoreBoundarySources())).toEqual([]);
  });

  it("loads only source contract files from a bare-core tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-audit-boundary-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "included.ts"), "export {};\n");
      await writeFile(path.join(root, "src", "ignored.md"), "--audit\n");
      await writeFile(path.join(root, "PRD.md"), "Core product contract.\n");
      expect(loadBareCoreBoundarySources(root).map((source) => source.path)).toEqual([
        "src/included.ts",
        "PRD.md",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports clean and violating CLI results", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;

    main([]);
    expect(log).toHaveBeenCalledWith("Audit package boundary gate passed.");

    main([{ path: "src/example.ts", line: 4, token: "--audit" }]);
    expect(error).toHaveBeenCalledWith("Audit package boundary violations detected:");
    expect(error).toHaveBeenCalledWith('- src/example.ts:4 contains "--audit"');
    expect(process.exitCode).toBe(1);

    process.exitCode = previousExitCode;
    log.mockRestore();
    error.mockRestore();
  });

  it("runs the CLI gate only for its own entrypoint", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runIfMain("another-script.mjs");
    expect(log).not.toHaveBeenCalled();
    runIfMain(
      fileURLToPath(
        new URL("../../../../scripts/release/audit-package-boundary.mjs", import.meta.url),
      ),
    );
    expect(log).toHaveBeenCalledWith("Audit package boundary gate passed.");
    log.mockRestore();
  });
});
