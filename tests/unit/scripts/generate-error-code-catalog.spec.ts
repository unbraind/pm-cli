import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/generate-error-code-catalog.mjs";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

describe("generate error code catalog", () => {
  it("discovers, classifies, sorts, writes, and verifies literal codes", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-");
    await mkdir(path.join(root, "src", "cli", "nested"), { recursive: true });
    await writeFile(
      path.join(root, "src", "cli", "errors.ts"),
      [
        'const a = { code: "item_not_found" };',
        'const b = { code: "lock_conflict" };',
        'const c = { code: "dependency_failed_child" };',
        'const d = { code: "unknown_flag" };',
        'const e = { code: "runtime_failure" };',
        'const f = new PmCliError("Ambiguous", EXIT_CODE.USAGE, { code: "ambiguous_list_all" });',
        'const g = new PmCliError("Protocol", 5, { "code": "protocol_failure" });',
        'const h = new PmCliError("Dynamic", error.exitCode, { code: "dynamic_failure" });',
        'const generic = { code: "unknown_error" };',
        'const typed = { code: "typed_failure" as const };',
        'const long = { code: "validate_metadata_custom_profile_missing_required_fields" };',
        'const wrappedUsage = { code: "history_author_acknowledge_selector_conflict" };',
        'const ignored = { code: dynamicCode, other: "value" };',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "cli", "nested", "more.ts"),
      'const duplicate = { code: "item_not_found" };',
      "utf8",
    );
    await writeFile(
      path.join(
        root,
        "src",
        "cli",
        "nested",
        "extremely-long-generated-runtime-error-declarations.ts",
      ),
      'const duplicate = { code: "item_not_found" };',
      "utf8",
    );
    await main(root, []);
    const output = await readFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "utf8",
    );
    expect(output).toContain('code: "item_not_found"');
    expect(output).toContain("exit_code: 3");
    expect(output).toContain("exit_code: 4");
    expect(output).toContain("exit_code: 5");
    expect(output).toContain("exit_code: 2");
    expect(output).toContain("exit_code: 1");
    expect(output).toContain('class: "usage"');
    expect(output).toMatch(
      /code: "unknown_error",[\s\S]*?exit_code: 1,[\s\S]*?class: "generic_failure"/u,
    );
    expect(output).toMatch(
      /code: "history_author_acknowledge_selector_conflict",[\s\S]*?exit_code: 2,[\s\S]*?class: "usage"/u,
    );
    expect(output).toContain('emitting_commands: ["*"]');
    expect(output).toContain('code: "ambiguous_list_all"');
    expect(output).toContain('code: "protocol_failure"');
    expect(output).not.toContain("exit_code: 64");
    expect(output).not.toContain("dynamicCode");
    expect(output.match(/code: "item_not_found"/g)).toHaveLength(1);
    await expect(main(root, ["--check"])).resolves.toBeUndefined();

    await mkdir(path.join(root, "src", "cli", "commands"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "cli", "commands", "create.ts"),
      'const added = { code: "new_create_failure" };',
      "utf8",
    );
    await main(root, []);
    const expanded = await readFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "utf8",
    );
    expect(expanded).toContain('code: "new_create_failure"');
    expect(expanded).toContain('stability: "provisional"');
    expect(expanded).toContain('emitting_commands: ["create"]');
    await writeFile(
      path.join(root, "src", "cli", "error-guidance.ts"),
      'const shared = { code: "new_create_failure" };',
      "utf8",
    );
    await main(root, []);
    const shared = await readFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "utf8",
    );
    expect(shared).toContain('emitting_commands: ["*", "create"]');
  });

  it("fails closed for missing and stale generated output", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-stale-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "source.ts"),
      'const failure = { code: "invalid_fixture" };',
      "utf8",
    );
    await expect(main(root, ["--check"])).rejects.toThrow(
      "stability ledger is missing",
    );
    await main(root, []);
    await rm(path.join(root, "src", "sdk", "generated-error-code-catalog.ts"));
    await expect(main(root, ["--check"])).rejects.toThrow(
      "error-code catalog is stale",
    );
    await main(root, []);
    await writeFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "stale\n",
      "utf8",
    );
    await expect(main(root, ["--check"])).rejects.toThrow(
      "error-code catalog is stale",
    );
  });

  it("fails closed when one code declares conflicting transport exits", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-conflict-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "source.ts"),
      [
        'new PmCliError("Usage", EXIT_CODE.USAGE, { code: "shared_failure" });',
        'new PmCliError("Conflict", EXIT_CODE.CONFLICT, { code: "shared_failure" });',
      ].join("\n"),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Conflicting explicit exit codes for shared_failure: 2, 4",
    );
    await expect(
      readFile(path.join(root, "scripts", "error-code-stability.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to remove a stable code without an explicit ledger change", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-removal-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    const sourcePath = path.join(root, "src", "sdk", "source.ts");
    await writeFile(
      sourcePath,
      'const failure = { code: "stable_failure" };',
      "utf8",
    );
    await main(root, []);
    await writeFile(sourcePath, "export {};", "utf8");
    await expect(main(root, [])).rejects.toThrow(
      "Stable error codes cannot be removed",
    );
  });

  it("rejects malformed stability ledgers and unsupported public exits", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-invalid-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    const sourcePath = path.join(root, "src", "sdk", "source.ts");
    const ledgerPath = path.join(root, "scripts", "error-code-stability.json");
    await writeFile(
      sourcePath,
      'new PmCliError("Unsupported", 64, { code: "unsupported_exit" });',
      "utf8",
    );
    await writeFile(
      ledgerPath,
      '{"schema_version":2,"stable_codes":[]}',
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Invalid error-code stability ledger",
    );
    await writeFile(
      ledgerPath,
      '{"schema_version":1,"stable_codes":[]}',
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Unsupported public exit code for unsupported_exit: 64",
    );
    await rm(ledgerPath);
    await mkdir(ledgerPath);
    await expect(main(root, [])).rejects.toMatchObject({ code: "EISDIR" });
  });
});
