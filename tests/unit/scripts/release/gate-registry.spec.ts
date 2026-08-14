/**
 * Gate-registry discovery and fail-closed policy tests.
 *
 * Tracker: pm-k6t4yb.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverWorkflowGates,
  main,
  runGateRegistryEntrypoint,
  validateGateRegistry,
} from "../../../../scripts/release/gate-registry.mjs";
import { GRAPH_SUBCOMMAND_VALUES } from "../../../../src/sdk/cli-contracts/enum-contracts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-gate-registry-"));
  roots.push(root);
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, ".github", "workflows", "ci.yml"),
    "jobs:\n  test:\n    steps:\n      - name: Checkout\n      - name: Build\n      - name: Run quality gate\n",
  );
  await writeFile(
    path.join(root, "tests", "negative.spec.ts"),
    "rejects drift",
  );
  await writeFile(path.join(root, "src", "claim.ts"), "CI gate");
  return root;
}

function registry() {
  return {
    version: 2,
    local_preflight: {
      command: "pnpm verify:preflight",
      steps: [
        {
          id: "quality",
          gates: ["quality"],
          executable: { command: "pnpm", args: ["quality:static"] },
          skip_policy: "forbidden",
        },
      ],
      hosted_only: [],
    },
    gates: [
      {
        id: "quality",
        owner: "pm-k6t4yb",
        pipelines: ["ci.yml#test"],
        failure_taxonomy: ["build_failed"],
        bypass: { allowed: false, audit: "Mandatory." },
        negative_control: {
          test: "tests/negative.spec.ts",
          assertion: "rejects drift",
        },
      },
    ],
    claims: [
      {
        source: "src/claim.ts",
        evidence: "CI gate",
        gate: "quality",
        disposition: "enforced",
      },
    ],
  };
}

describe("gate registry", () => {
  it("discovers every stable workflow job without reading display names", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, ".github", "workflows", "other.yaml"),
      "jobs:\n  quality:\n    steps:\n      - name: Install test tools\n      - name: 'Security scan'\n      - name: Build\n      - run: |\n          echo '- name: Fake quality gate'\n",
    );
    await writeFile(
      path.join(root, ".github", "workflows", "notes.txt"),
      "- name: Ignored check\n",
    );
    await writeFile(
      path.join(root, ".github", "workflows", "nonsteps.yml"),
      "jobs:\n  reusable:\n    uses: owner/repo/.github/workflows/check.yml@main\n  empty:\n    steps:\n      - run: echo no-name\n      - null\n",
    );
    await writeFile(
      path.join(root, ".github", "workflows", "empty.yml"),
      "jobs: null\n",
    );

    await expect(
      discoverWorkflowGates(path.join(root, ".github", "workflows")),
    ).resolves.toEqual([
      "ci.yml#test",
      "nonsteps.yml#empty",
      "nonsteps.yml#reusable",
      "other.yaml#quality",
    ]);
  });

  it("accepts exact ownership, negative controls, and source claims", async () => {
    const root = await fixtureRoot();
    await expect(
      validateGateRegistry(registry(), { repoRoot: root }),
    ).resolves.toEqual([]);
  });

  it("enforces gate-script disposition and graph-operation consumer inventories", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "scripts", "release"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "scripts", "release", "quality-gate.mjs"), "quality");
    await writeFile(path.join(root, "scripts", "release", "typed-gate.mts"), "typed");
    await writeFile(path.join(root, "tests", "quality.spec.ts"), "seeded regression");
    const declared = {
      ...registry(),
      automation_inventory: {
      gate_scripts: [
        {
          path: "scripts/release/quality-gate.mjs",
          disposition: "reduced_to_provider",
          provider: "repository-quality/quality",
          negative_control: {
            test: "tests/quality.spec.ts",
            assertion: "seeded regression",
          },
        },
        {
          path: "scripts/release/retired-gate.mjs",
          disposition: "migrated",
          replacement: "pm assurance run fixture-quality",
        },
        {
          path: "scripts/release/typed-gate.mts",
          disposition: "retained",
          reason: "This fixture remains a typed executable quality boundary.",
        },
      ],
        provider_checks: [
          {
            kind: "provider_check",
            path: "scripts/release/quality-gate.mjs",
            provider: "repository-quality/recovery",
            provider_args: ["--check"],
            negative_control: {
              test: "tests/quality.spec.ts",
              assertion: "seeded regression",
            },
          },
        ],
        graph_operations: GRAPH_SUBCOMMAND_VALUES.map((operation) => ({
          operation,
          interactive_only_reason: "This fixture operation is intentionally user-invoked only.",
        })),
      },
    };
    await expect(validateGateRegistry(declared, { repoRoot: root })).resolves.toEqual([]);

    const typedGate = declared.automation_inventory.gate_scripts[2];
    declared.automation_inventory.gate_scripts[2] = {
      path: typedGate.path,
      disposition: "reduced_to_provider",
      provider: declared.automation_inventory.gate_scripts[0].provider,
      negative_control: {
        test: "tests/quality.spec.ts",
        assertion: "seeded regression",
      },
    };
    await expect(
      validateGateRegistry(declared, { repoRoot: root }),
    ).resolves.toContain("automation_inventory:provider:duplicate");
    declared.automation_inventory.gate_scripts[2] = typedGate;

    declared.automation_inventory.gate_scripts[2].reason = "short";
    declared.automation_inventory.provider_checks[0].provider = "invalid";
    declared.automation_inventory.graph_operations[0] = {
      operation: GRAPH_SUBCOMMAND_VALUES[0],
    } as never;
    await expect(validateGateRegistry(declared, { repoRoot: root })).resolves.toEqual(
      expect.arrayContaining([
        "automation_inventory:gate_script:invalid",
        "automation_inventory:provider_check:invalid",
        "automation_inventory:graph_operation:invalid",
      ]),
    );

    declared.automation_inventory.provider_checks = {} as never;
    await expect(
      validateGateRegistry(declared, { repoRoot: root }),
    ).resolves.toContain("automation_inventory:provider_checks:invalid");

    declared.automation_inventory.provider_checks = [
      {
        kind: "provider_check",
        path: "scripts/missing-provider.mjs",
        provider: "repository-quality/missing",
        provider_args: ["--check"],
        negative_control: {
          test: "tests/quality.spec.ts",
          assertion: "seeded regression",
        },
      },
    ];
    await expect(
      validateGateRegistry(declared, { repoRoot: root }),
    ).resolves.toContain(
      "automation_inventory:provider_check:scripts/missing-provider.mjs:missing",
    );

    declared.automation_inventory.gate_scripts = [
      {
        path: "scripts/release/quality-gate.mjs",
        disposition: "retained",
        reason: "This fixture remains the executable quality boundary.",
      },
      {
        path: "scripts/release/typed-gate.mts",
        disposition: "retained",
        reason: "This fixture remains a typed executable quality boundary.",
      },
      {
        path: "scripts/release/retired-gate.mjs",
        disposition: "migrated",
        replacement: "pm assurance run fixture-quality",
      },
    ];
    await expect(
      validateGateRegistry(declared, { repoRoot: root }),
    ).resolves.toContain("automation_inventory:migration_majority_not_met");
  });

  it("fails closed across incomplete automation-inventory dispositions", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "scripts", "release"), { recursive: true });
    await Promise.all(
      [
        "quality-gate.mjs",
        "provider-gate.mjs",
        "undeclared-gate.mjs",
        "undeclared-gate.ts",
      ].map(
        (file) => writeFile(path.join(root, "scripts", "release", file), file),
      ),
    );
    const graphOperations = GRAPH_SUBCOMMAND_VALUES.slice(1).map(
      (operation) => ({
        operation,
        automated_consumer: "pm assurance run fixture-quality",
      }),
    );
    graphOperations.push({
      operation: GRAPH_SUBCOMMAND_VALUES[1],
      automated_consumer: "pm assurance run fixture-quality",
    });
    graphOperations.push({
      operation: "unknown",
      automated_consumer: "pm assurance run fixture-quality",
    } as never);
    graphOperations.push({
      automated_consumer: "pm assurance run fixture-quality",
    } as never);
    const invalid = {
      ...registry(),
      automation_inventory: {
        gate_scripts: [
          {
            path: "scripts/release/quality-gate.mjs",
            disposition: "retained",
            reason: "This retained fixture gate has a complete rationale.",
          },
          {
            path: "scripts/release/provider-gate.mjs",
            disposition: "reduced_to_provider",
            provider: "fixture-provider",
          },
          {
            path: "scripts/release/missing-gate.mjs",
            disposition: "reduced_to_provider",
            provider: "x",
          },
          {
            path: "scripts/release/quality-gate.mjs",
            disposition: "migrated",
            replacement: "short",
          },
          { disposition: "retained" },
        ],
        graph_operations: graphOperations,
      },
    };
    await expect(validateGateRegistry(invalid, { repoRoot: root })).resolves.toEqual(
      expect.arrayContaining([
        "automation_inventory:gate_script:invalid",
        "automation_inventory:gate_script:scripts/release/undeclared-gate.mjs:undeclared",
        "automation_inventory:gate_script:scripts/release/undeclared-gate.ts:undeclared",
        "automation_inventory:graph_operation:invalid",
        `automation_inventory:graph_operation:${GRAPH_SUBCOMMAND_VALUES[0]}:undeclared`,
      ]),
    );

    await expect(
      validateGateRegistry(
        { ...registry(), automation_inventory: null },
        { repoRoot: root },
      ),
    ).resolves.toContain("automation_inventory:invalid");
  });

  it("fails closed for malformed, duplicate, stale, and missing policy", async () => {
    const root = await fixtureRoot();
    await expect(
      validateGateRegistry({ version: 2 }, { repoRoot: root }),
    ).resolves.toEqual(["registry:requires_version_2_gates_array"]);

    const invalid = registry();
    invalid.gates.push({
      ...invalid.gates[0],
      id: "quality",
      owner: "invalid",
      pipelines: ["ci.yml#test", "ci.yml#test", "ci.yml#ghost"],
      failure_taxonomy: [],
      bypass: { allowed: false, audit: "" },
      negative_control: {
        test: "tests/missing.spec.ts",
        assertion: "missing",
      },
    });
    invalid.claims.push({
      source: "src/missing.ts",
      evidence: "missing",
      gate: "unknown",
      disposition: "unknown",
    });

    const violations = await validateGateRegistry(invalid, { repoRoot: root });
    expect(violations).toEqual(
      expect.arrayContaining([
        "gate:quality:duplicate",
        "gate:quality:owner_invalid",
        "gate:quality:failure_taxonomy:requires_non_empty_strings",
        "gate:quality:bypass_invalid",
        "gate:quality:negative_control_test_missing",
        "gate:quality:pipeline:ci.yml#test:duplicate",
        "pipeline:ci.yml#ghost:not_enforced",
        "claim:invalid",
      ]),
    );
    const invalidNegative = registry();
    invalidNegative.gates[0].negative_control = null as never;
    await expect(
      validateGateRegistry(invalidNegative, { repoRoot: root }),
    ).resolves.toContain("gate:quality:negative_control_invalid");

    const invalidLocal = registry();
    invalidLocal.local_preflight = {
      command: "wrong",
      steps: [],
      hosted_only: [],
    };
    await expect(
      validateGateRegistry(invalidLocal, { repoRoot: root }),
    ).resolves.toContain("local_preflight:invalid");

    const invalidStep = registry();
    invalidStep.local_preflight.steps.push({
      id: "quality",
      gates: ["missing"],
    });
    await expect(
      validateGateRegistry(invalidStep, { repoRoot: root }),
    ).resolves.toContain("local_preflight:step_invalid");

    const invalidExecutable = registry();
    invalidExecutable.local_preflight.steps[0].executable = {
      command: "shell",
      args: [],
    };
    invalidExecutable.local_preflight.steps[0].skip_policy = "optional";
    await expect(
      validateGateRegistry(invalidExecutable, { repoRoot: root }),
    ).resolves.toContain("local_preflight:step_invalid");

    const hostedOnly = registry();
    hostedOnly.local_preflight.steps = [];
    hostedOnly.local_preflight.hosted_only = [
      {
        gate: "quality",
        reason: "This fixture gate requires a clean hosted runner environment.",
      },
    ];
    await expect(
      validateGateRegistry(hostedOnly, { repoRoot: root }),
    ).resolves.toEqual([]);

    const invalidHostedOnly = registry();
    invalidHostedOnly.local_preflight.steps = [];
    invalidHostedOnly.local_preflight.hosted_only = [
      { gate: "missing", reason: "short" },
    ];
    await expect(
      validateGateRegistry(invalidHostedOnly, { repoRoot: root }),
    ).resolves.toEqual(
      expect.arrayContaining([
        "local_preflight:hosted_only_invalid",
        "local_preflight:gate:quality:unmapped",
      ]),
    );
  });

  it("reports missing enforced pipelines, assertions, claims, and invalid ids", async () => {
    const root = await fixtureRoot();
    const invalid = registry();
    invalid.gates[0] = {
      ...invalid.gates[0],
      id: "-invalid",
      pipelines: ["ci.yml#ghost"],
      negative_control: {
        test: "tests/negative.spec.ts",
        assertion: "absent",
      },
    };

    const violations = await validateGateRegistry(invalid, { repoRoot: root });
    expect(violations).toEqual(
      expect.arrayContaining([
        "gate:id_invalid",
        "pipeline:ci.yml#test:unregistered",
        "claim:invalid",
      ]),
    );
    invalid.gates[0].id = "quality";
    await expect(
      validateGateRegistry(invalid, { repoRoot: root }),
    ).resolves.toContain("gate:quality:negative_control_assertion_missing");

    const missingClaims = registry();
    missingClaims.claims = [
      {
        source: "src/claim.ts",
        evidence: "absent",
        gate: "quality",
        disposition: "enforced",
      },
      {
        source: "src/missing.ts",
        evidence: "CI gate",
        gate: "quality",
        disposition: "enforced",
      },
    ];
    await expect(
      validateGateRegistry(missingClaims, { repoRoot: root }),
    ).resolves.toEqual([
      "claim:src/claim.ts:evidence_missing",
      "claim:src/missing.ts:source_missing",
    ]);
    const emptyEvidence = registry();
    emptyEvidence.claims[0].evidence = "";
    await expect(
      validateGateRegistry(emptyEvidence, { repoRoot: root }),
    ).resolves.toEqual(["claim:invalid"]);

    await writeFile(
      path.join(root, ".github", "workflows", "broken.yml"),
      "jobs: [",
    );
    await expect(
      discoverWorkflowGates(path.join(root, ".github", "workflows")),
    ).rejects.toThrow("Invalid workflow YAML broken.yml");
  });

  it("validates the committed registry and prints its live inventory", async () => {
    const committed = JSON.parse(
      await readFile(
        path.join(process.cwd(), "scripts", "release", "gate-registry.json"),
        "utf8",
      ),
    );
    const inventory = await main(["--inventory"]);
    const result = await main([]);
    expect(result).toMatchObject({
      ok: true,
      registered_gate_count: committed.gates.length,
      claim_count: committed.claims.length,
    });
    expect(result.enforced_pipeline_count).toBe(inventory.workflow_jobs.length);
    expect(inventory.registered).toEqual(inventory.workflow_jobs);
    expect(inventory.registered.length).toBe(
      new Set(
        committed.gates.flatMap(
          (gate: { pipelines: string[] }) => gate.pipelines,
        ),
      ).size,
    );
    expect(committed.version).toBe(2);
    expect(
      committed.automation_inventory.graph_operations.map(
        (entry: { operation: string }) => entry.operation,
      ),
    ).toEqual(GRAPH_SUBCOMMAND_VALUES);
    const root = await fixtureRoot();
    const claimsFreePath = path.join(root, "claims-free.json");
    delete committed.claims;
    delete committed.automation_inventory;
    await writeFile(claimsFreePath, JSON.stringify(committed));
    await expect(main(["--registry", claimsFreePath])).resolves.toMatchObject({
      ok: true,
      claim_count: 0,
      migrated_gate_script_count: 0,
      declared_graph_operation_count: 0,
    });
  });

  it("fails invalid registry files and runs entrypoint outcomes", async () => {
    const root = await fixtureRoot();
    const invalidPath = path.join(root, "invalid.json");
    await writeFile(
      invalidPath,
      JSON.stringify({ version: 2, gates: [], claims: [] }),
    );
    await expect(main(["--registry", invalidPath])).rejects.toThrow(
      "Gate registry validation failed",
    );

    const scriptPath = path.resolve(
      process.cwd(),
      "scripts/release/gate-registry.mjs",
    );
    const write = vi.fn();
    await expect(
      runGateRegistryEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => ({ ok: true }),
        write,
      }),
    ).resolves.toBe(true);
    expect(String(write.mock.calls[0]?.[0])).toContain('"ok": true');
    await expect(
      runGateRegistryEntrypoint({
        argv: [process.execPath, scriptPath, "--inventory"],
        write,
      }),
    ).resolves.toBe(true);
    await expect(
      runGateRegistryEntrypoint({ argv: [process.execPath] }),
    ).resolves.toBe(false);
    const onError = vi.fn();
    await expect(
      runGateRegistryEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("registry failed");
        },
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalled();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await runGateRegistryEntrypoint({
      argv: [process.execPath, scriptPath],
      run: async () => ({ ok: true }),
    });
    expect(stdout).toHaveBeenCalled();
    stdout.mockRestore();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT:1");
    }) as never);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      runGateRegistryEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => {
          throw new Error("default registry failure");
        },
      }),
    ).rejects.toThrow("EXIT:1");
    expect(error).toHaveBeenCalledWith("Error: default registry failure");
    exit.mockRestore();
    error.mockRestore();
  });
});
