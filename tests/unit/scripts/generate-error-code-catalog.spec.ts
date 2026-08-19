import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/generate-error-code-catalog.mjs";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

async function readGeneratedCatalog(root: string): Promise<string> {
  const sdkRoot = path.join(root, "src", "sdk");
  const generatedRoot = path.join(sdkRoot, "generated");
  const generatedParts = (await readdir(generatedRoot))
    .filter((name) => /^generated-error-code-catalog-part-\d+\.ts$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.join("generated", name));
  return (
    await Promise.all(
      ["generated-error-code-catalog.ts", ...generatedParts].map((name) =>
        readFile(path.join(sdkRoot, name), "utf8"),
      ),
    )
  ).join("\n");
}

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
      'const duplicate = { code: "lock_conflict" };',
      "utf8",
    );
    await mkdir(path.join(root, "src", "sdk", "query"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "query", "search-contracts.ts"),
      'const projection = { code: "projection_options_mutually_exclusive" };',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "sdk", "query", "list.ts"),
      'const listQuery = { code: "list_query_failure" };',
      "utf8",
    );
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "scripts", "error-code-reachability.json"),
      JSON.stringify({
        schema_version: 1,
        codes: {
          unknown_flag: [
            {
              state: "unknown_option_on_selected_path",
              probe_id: "unknown-option",
              entrypoints: ["test-all"],
              expected_exit_class: "usage",
            },
          ],
        },
      }),
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
    await writeFile(
      path.join(
        root,
        "src",
        "cli",
        "nested",
        "another-extremely-long-generated-runtime-error-declarations.ts",
      ),
      'const duplicate = { code: "lock_conflict" };',
      "utf8",
    );
    await main(root, []);
    const output = await readGeneratedCatalog(root);
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
    const projectionRecord = output.match(
      / {2}\{\n {4}code: "projection_options_mutually_exclusive",[\s\S]*?\n {2}\},/u,
    )?.[0];
    const listQueryRecord = output.match(
      / {2}\{\n {4}code: "list_query_failure",[\s\S]*?\n {2}\},/u,
    )?.[0];
    expect(projectionRecord).toContain('emitting_commands: ["search"]');
    expect(listQueryRecord).toContain('emitting_commands: ["list"]');
    expect(output).toContain('canonical_code: "item_not_found"');
    expect(output).toContain("aliases: []");
    expect(output).toContain(
      '    sources: ["cli/errors.ts", "cli/nested/extremely-long-generated-runtime-error-declarations.ts"],',
    );
    expect(output).toContain('state: "unknown_option_on_selected_path"');
    expect(output).toContain('probe_id: "unknown-option"');
    expect(output).toContain('code: "ambiguous_list_all"');
    expect(output).toContain('code: "protocol_failure"');
    expect(output).not.toContain("exit_code: 64");
    expect(output).not.toContain("dynamicCode");
    expect(output.match(/^\s{4}code: "item_not_found"/gmu)).toHaveLength(1);
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
    const expanded = await readGeneratedCatalog(root);
    expect(expanded).toContain('code: "new_create_failure"');
    expect(expanded).toContain('stability: "provisional"');
    expect(expanded).toContain('emitting_commands: ["create"]');
    await writeFile(
      path.join(root, "src", "cli", "error-guidance.ts"),
      'const shared = { code: "new_create_failure" };',
      "utf8",
    );
    await main(root, []);
    const shared = await readGeneratedCatalog(root);
    expect(shared).toContain('emitting_commands: ["*", "create"]');
    await mkdir(path.join(root, "src", "sdk", "lifecycle"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "sdk", "lifecycle", "update.ts"),
      'const conflict = { code: "acceptance_criteria_mutation_conflict" };',
      "utf8",
    );
    await main(root, []);
    const withBulkCaller = await readGeneratedCatalog(root);
    expect(withBulkCaller).toMatch(
      /code: "acceptance_criteria_mutation_conflict",[\s\S]*?emitting_commands: \["update", "update-many"\]/u,
    );
    await writeFile(
      path.join(root, "src", "sdk", "lifecycle", "reopen.ts"),
      'const recurrence = { code: "reopen_reason_required" };',
      "utf8",
    );
    await main(root, []);
    const withReopenCaller = await readGeneratedCatalog(root);
    expect(withReopenCaller).toMatch(
      /code: "reopen_reason_required",[\s\S]*?emitting_commands: \["item reopen"\]/u,
    );
    const stabilityLedger = JSON.parse(
      await readFile(
        path.join(root, "scripts", "error-code-stability.json"),
        "utf8",
      ),
    ) as {
      schema_version: number;
      aliases: Record<string, string>;
      exit_codes: Record<string, number>;
    };
    expect(stabilityLedger.schema_version).toBe(2);
    expect(stabilityLedger.aliases).toEqual({});
    expect(stabilityLedger.exit_codes.item_not_found).toBe(3);
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
    await main(root, []);
    await rm(
      path.join(
        root,
        "src",
        "sdk",
        "generated",
        "generated-error-code-catalog-part-1.ts",
      ),
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

  it("renders reviewed aliases and rejects incompatible alias transports", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-alias-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "source.ts"),
      [
        'const canonical = { code: "unknown_command" };',
        'const alias = { code: "unknown_subcommand" };',
      ].join("\n"),
      "utf8",
    );
    const ledgerPath = path.join(root, "scripts", "error-code-stability.json");
    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["unknown_command", "unknown_subcommand"],
        aliases: { unknown_subcommand: "unknown_command" },
        exit_codes: { unknown_command: 2, unknown_subcommand: 2 },
      }),
      "utf8",
    );
    await main(root, []);
    const output = await readGeneratedCatalog(root);
    expect(output).toMatch(
      /code: "unknown_command",[\s\S]*?canonical_code: "unknown_command",[\s\S]*?aliases: \["unknown_subcommand"\]/u,
    );
    expect(output).toMatch(
      /code: "unknown_subcommand",[\s\S]*?canonical_code: "unknown_command",[\s\S]*?aliases: \[\]/u,
    );

    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["unknown_command", "unknown_subcommand"],
        aliases: { unknown_subcommand: "unknown_command" },
        exit_codes: { unknown_command: 2, unknown_subcommand: 4 },
      }),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow("Alias transport mismatch");
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
      '{"schema_version":3,"stable_codes":[],"aliases":{},"exit_codes":{}}',
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Invalid error-code stability ledger",
    );
    await writeFile(
      ledgerPath,
      '{"schema_version":2,"stable_codes":[],"aliases":{},"exit_codes":{}}',
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Unsupported public exit code for unsupported_exit: 64",
    );
    await rm(ledgerPath);
    await mkdir(ledgerPath);
    await expect(main(root, [])).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("rejects invalid or contradictory refusal reachability declarations", async () => {
    const root = await harness.createTempRoot("pm-error-reachability-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "source.ts"),
      'const failure = { code: "unknown_fixture" };',
      "utf8",
    );
    const reachabilityPath = path.join(
      root,
      "scripts",
      "error-code-reachability.json",
    );
    await writeFile(reachabilityPath, '{"schema_version":2,"codes":{}}');
    await expect(main(root, [])).rejects.toThrow(
      "Invalid error-code reachability ledger",
    );
    await writeFile(
      reachabilityPath,
      JSON.stringify({
        schema_version: 1,
        codes: {
          unknown_fixture: [
            {
              state: "fixture_state",
              probe_id: "fixture-state",
              entrypoints: [],
              expected_exit_class: "usage",
            },
          ],
        },
      }),
    );
    await expect(main(root, [])).rejects.toThrow(
      "Invalid error-code reachability ledger",
    );
    await writeFile(
      reachabilityPath,
      JSON.stringify({
        schema_version: 1,
        codes: {
          missing_code: [
            {
              state: "missing_state",
              probe_id: "missing-state",
              entrypoints: ["fixture"],
              expected_exit_class: "usage",
            },
          ],
        },
      }),
    );
    await expect(main(root, [])).rejects.toThrow(
      "Reachability declaration names unknown code",
    );
    await writeFile(
      reachabilityPath,
      JSON.stringify({
        schema_version: 1,
        codes: {
          unknown_fixture: [
            {
              state: "fixture_state",
              probe_id: "fixture-state",
              entrypoints: ["fixture"],
              expected_exit_class: "conflict",
            },
          ],
        },
      }),
    );
    await expect(main(root, [])).rejects.toThrow(
      "Reachability exit class mismatch for unknown_fixture",
    );
    await rm(reachabilityPath);
    await mkdir(reachabilityPath);
    await expect(main(root, [])).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("fails closed across ledger migration, shape, alias, and transport drift", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-ledger-drift-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    const sourcePath = path.join(root, "src", "sdk", "source.ts");
    const ledgerPath = path.join(root, "scripts", "error-code-stability.json");
    await writeFile(
      sourcePath,
      'new PmCliError("Usage", EXIT_CODE.USAGE, { code: "stable_failure" });',
      "utf8",
    );

    await writeFile(
      ledgerPath,
      JSON.stringify({ schema_version: 1, stable_codes: ["stable_failure"] }),
      "utf8",
    );
    await expect(main(root, ["--check"])).rejects.toThrow(
      "requires schema-version migration",
    );
    await main(root, []);
    await expect(main(root, ["--check"])).resolves.toBeUndefined();

    const malformedLedgers = [
      { aliases: null, exit_codes: {} },
      { aliases: [], exit_codes: {} },
      { aliases: { "Bad Alias": "stable_failure" }, exit_codes: {} },
      { aliases: { stable_alias: 3 }, exit_codes: {} },
      { aliases: { stable_alias: "Bad Canonical" }, exit_codes: {} },
      { aliases: {}, exit_codes: null },
      { aliases: {}, exit_codes: [] },
      { aliases: {}, exit_codes: { "Bad Code": 2 } },
      { aliases: {}, exit_codes: { stable_failure: 2.5 } },
    ];
    for (const malformed of malformedLedgers) {
      await writeFile(
        ledgerPath,
        JSON.stringify({
          schema_version: 2,
          stable_codes: ["stable_failure"],
          ...malformed,
        }),
        "utf8",
      );
      await expect(main(root, [])).rejects.toThrow(
        "Invalid error-code stability ledger",
      );
    }

    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["stable_failure"],
        aliases: {},
        exit_codes: { stable_failure: 4 },
      }),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Reviewed exit code disagrees with executable transport",
    );

    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["stable_failure"],
        aliases: {},
        exit_codes: {},
      }),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Stable error code is missing a reviewed exit code",
    );

    await writeFile(
      sourcePath,
      [
        'new PmCliError("Usage", EXIT_CODE.USAGE, { code: "stable_failure" });',
        'new PmCliError("Alias", EXIT_CODE.USAGE, { code: "alias_failure" });',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["alias_failure", "stable_failure"],
        aliases: { alias_failure: "alias_failure" },
        exit_codes: { alias_failure: 2, stable_failure: 2 },
      }),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Invalid error-code alias: alias_failure -> alias_failure",
    );

    await writeFile(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        stable_codes: ["alias_failure", "stable_failure"],
        aliases: {},
        exit_codes: {
          alias_failure: 2,
          stable_failure: 2,
          unexpected_failure: 2,
        },
      }),
      "utf8",
    );
    await expect(main(root, [])).rejects.toThrow(
      "Reviewed exit codes must name stable codes only",
    );
  });
});
