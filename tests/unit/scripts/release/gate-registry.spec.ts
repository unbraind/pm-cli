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
    version: 1,
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
        pipelines: ["ci.yml#Build", "ci.yml#Run quality gate"],
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
  it("discovers named gates while excluding setup and duplicate steps", async () => {
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
      "ci.yml#Build",
      "ci.yml#Run quality gate",
      "other.yaml#Build",
      "other.yaml#Security scan",
    ]);
  });

  it("accepts exact ownership, negative controls, and source claims", async () => {
    const root = await fixtureRoot();
    await expect(
      validateGateRegistry(registry(), { repoRoot: root }),
    ).resolves.toEqual([]);
  });

  it("fails closed for malformed, duplicate, stale, and missing policy", async () => {
    const root = await fixtureRoot();
    await expect(
      validateGateRegistry({ version: 2 }, { repoRoot: root }),
    ).resolves.toEqual(["registry:requires_version_1_gates_array"]);

    const invalid = registry();
    invalid.gates.push({
      ...invalid.gates[0],
      id: "quality",
      owner: "invalid",
      pipelines: ["ci.yml#Build", "ci.yml#Ghost check"],
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
        "pipeline:ci.yml#Build:duplicate_owner",
        "pipeline:ci.yml#Ghost check:not_enforced",
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
      pipelines: ["ci.yml#Build"],
      negative_control: {
        test: "tests/negative.spec.ts",
        assertion: "absent",
      },
    };

    const violations = await validateGateRegistry(invalid, { repoRoot: root });
    expect(violations).toEqual(
      expect.arrayContaining([
        "gate:id_invalid",
        "pipeline:ci.yml#Build:unregistered",
        "pipeline:ci.yml#Run quality gate:unregistered",
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
    expect(result.enforced_pipeline_count).toBe(inventory.discovered.length);
    expect(inventory.discovered.length).toBe(
      committed.gates.flatMap((gate: { pipelines: string[] }) => gate.pipelines)
        .length,
    );
    expect(committed.version).toBe(1);
    const root = await fixtureRoot();
    const claimsFreePath = path.join(root, "claims-free.json");
    delete committed.claims;
    await writeFile(claimsFreePath, JSON.stringify(committed));
    await expect(main(["--registry", claimsFreePath])).resolves.toMatchObject({
      ok: true,
      claim_count: 0,
    });
  });

  it("fails invalid registry files and runs entrypoint outcomes", async () => {
    const root = await fixtureRoot();
    const invalidPath = path.join(root, "invalid.json");
    await writeFile(
      invalidPath,
      JSON.stringify({ version: 1, gates: [], claims: [] }),
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
