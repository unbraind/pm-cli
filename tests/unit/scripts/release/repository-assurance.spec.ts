import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withTempDir } from "../../../helpers/temp.js";
import { commandFor } from "../../../../scripts/release/utils.mjs";

const loadModule = () =>
  import("../../../../scripts/release/repository-assurance.mjs");

describe("repository assurance provider host", () => {
  it("reads only repository-scoped provider migrations", async () => {
    await withTempDir("pm-repository-assurance-", async (root) => {
      const registryPath = path.join(root, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          automation_inventory: {
            gate_scripts: [
              {
                path: "scripts/release/example-gate.mjs",
                disposition: "reduced_to_provider",
                provider: "repository-quality/example",
              },
              {
                path: "scripts/release/other-gate.mjs",
                disposition: "reduced_to_provider",
                provider: "other/example",
              },
              {
                path: "scripts/release/retained-gate.mjs",
                disposition: "retained",
              },
            ],
          },
        }),
      );

      await expect(
        loadModule().then((module) =>
          module.readRepositoryProviderEntries(registryPath),
        ),
      ).resolves.toEqual(
        new Map([
          [
            "example",
            expect.objectContaining({ provider: "repository-quality/example" }),
          ],
        ]),
      );
    });
  });

  it("reads provider-check entries", async () => {
    await withTempDir("pm-repository-assurance-", async (root) => {
      const registryPath = path.join(root, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          automation_inventory: {
            provider_checks: [
              {
                kind: "provider_check",
                path: "scripts/release/provider-check.mjs",
                provider: "repository-quality/provider-check",
              },
            ],
          },
        }),
      );
      await expect(
        loadModule().then((module) =>
          module.readRepositoryProviderEntries(registryPath),
        ),
      ).resolves.toEqual(
        new Map([
          [
            "provider-check",
            expect.objectContaining({ kind: "provider_check" }),
          ],
        ]),
      );
    });
  });

  it("rejects migrated entries without a provider", async () => {
    await withTempDir("pm-repository-assurance-", async (root) => {
      const registryPath = path.join(root, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          automation_inventory: {
            gate_scripts: [
              {
                path: "scripts/release/missing-provider.mjs",
                disposition: "reduced_to_provider",
              },
            ],
          },
        }),
      );
      await expect(
        loadModule().then((module) =>
          module.readRepositoryProviderEntries(registryPath),
        ),
      ).rejects.toThrow(
        "scripts/release/missing-provider.mjs has no string provider",
      );
    });
  });

  it("rejects duplicate repository providers", async () => {
    await withTempDir("pm-repository-assurance-", async (root) => {
      const registryPath = path.join(root, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          automation_inventory: {
            gate_scripts: [
              {
                path: "scripts/release/first.mjs",
                disposition: "reduced_to_provider",
                provider: "repository-quality/example",
              },
              {
                path: "scripts/release/second.mjs",
                disposition: "reduced_to_provider",
                provider: "repository-quality/example",
              },
            ],
          },
        }),
      );
      await expect(
        loadModule().then((module) =>
          module.readRepositoryProviderEntries(registryPath),
        ),
      ).rejects.toThrow(
        "repository-quality/example is duplicated by scripts/release/first.mjs and scripts/release/second.mjs",
      );
    });
  });

  it("executes JavaScript and TypeScript adapters and preserves failure evidence", async () => {
    const module = await loadModule();
    const execute = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "negative", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "pass", stderr: "" })
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "regressed" });
    const entries = new Map([
      [
        "javascript",
        {
          path: "scripts/release/example-gate.mjs",
          provider_args: ["--strict"],
          provider_negative_args: ["--negative-control"],
          provider_timeout_ms: 12_345,
        },
      ],
      [
        "typescript",
        {
          path: "scripts/release/example-gate.mts",
        },
      ],
    ]);

    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          kind: "provider",
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "javascript",
        },
        { entries, execute },
      ),
    ).resolves.toEqual({
      value: 1,
      population_size: 1,
      cost: 1,
      contributors: [],
    });
    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          kind: "provider",
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "typescript",
        },
        { entries, execute },
      ),
    ).resolves.toMatchObject({
      value: 0,
      contributors: [
        expect.stringContaining("example-gate.mts:exit:2:regressed"),
      ],
    });
    expect(execute.mock.calls[0][1]).toEqual([
      expect.stringContaining("example-gate.mjs"),
      "--negative-control",
    ]);
    expect(execute.mock.calls[1][1]).toEqual([
      expect.stringContaining("example-gate.mjs"),
      "--strict",
    ]);
    expect(execute.mock.calls[2][1]).toEqual([
      "exec",
      "tsx",
      expect.stringContaining("example-gate.mts"),
    ]);
    expect(execute.mock.calls[2][0]).toBe(commandFor("pnpm"));
    expect(execute.mock.calls[1][0]).toBe(process.execPath);
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 12_345 });
    expect(execute.mock.calls[1][2]).toMatchObject({ timeout: 12_345 });
    expect(execute.mock.calls[2][2]).toMatchObject({ timeout: 300_000 });
  });

  it("rejects malformed adapter timeouts before process execution", async () => {
    const module = await loadModule();
    for (const timeout of [0, -1, 1.5, "1000"]) {
      const execute = vi.fn();
      await expect(
        module.resolveRepositoryQualityMeasurement(
          {
            provider: module.REPOSITORY_QUALITY_PROVIDER,
            key: "invalid-timeout",
          },
          {
            entries: new Map([
              [
                "invalid-timeout",
                {
                  path: "scripts/release/example-gate.mjs",
                  provider_negative_args: ["--negative-control"],
                  provider_timeout_ms: timeout,
                },
              ],
            ]),
            execute,
          },
        ),
      ).rejects.toThrow(
        `invalid-timeout has invalid provider_timeout_ms ${String(timeout)}`,
      );
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("executes default repository inventory and preserves empty failure detail", async () => {
    const module = await loadModule();
    const defaultExecute = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });
    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "absence-tolerance",
        },
        { execute: defaultExecute },
      ),
    ).resolves.toMatchObject({ value: 1, population_size: 1 });
    expect(defaultExecute).toHaveBeenCalled();

    const execute = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 4, stdout: "", stderr: "" });
    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "typed-negative",
        },
        {
          entries: new Map([
            [
              "typed-negative",
              {
                path: "scripts/release/example-gate.mts",
                provider_negative_args: ["--negative-control"],
              },
            ],
          ]),
          execute,
        },
      ),
    ).resolves.toEqual({
      value: 0,
      population_size: 1,
      cost: 1,
      contributors: ["scripts/release/example-gate.mts:exit:4"],
    });
    expect(execute.mock.calls[0][1]).toEqual([
      "exec",
      "tsx",
      expect.stringContaining("example-gate.mts"),
      "--negative-control",
    ]);
  });

  it("blocks when an executable negative-control proof fails", async () => {
    const module = await loadModule();
    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "escaped",
        },
        {
          entries: new Map([
            [
              "escaped",
              {
                path: "scripts/release/escaped-gate.mjs",
                provider_negative_args: ["--negative-control"],
              },
            ],
          ]),
          execute: vi.fn().mockReturnValue({
            status: 3,
            stdout: "",
            stderr: "control escaped",
          }),
        },
      ),
    ).resolves.toEqual({
      value: 0,
      population_size: 1,
      cost: 1,
      contributors: [
        "scripts/release/escaped-gate.mjs:negative-control:exit:3",
      ],
    });
  });

  it("refuses undeclared providers and keys", async () => {
    const module = await loadModule();
    await expect(
      module.resolveRepositoryQualityMeasurement({
        provider: "other",
        key: "static",
      }),
    ).rejects.toThrow("Unsupported repository assurance provider");
    await expect(
      module.resolveRepositoryQualityMeasurement(
        {
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "missing",
        },
        { entries: new Map() },
      ),
    ).rejects.toThrow("is not declared");
  });

  it("binds the provider into a dry public SDK action", async () => {
    await withTempDir("pm-repository-assurance-", async (root) => {
      const registryPath = path.join(root, "registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({ automation_inventory: { gate_scripts: [] } }),
      );
      const runAction = vi.fn().mockResolvedValue({
        gate_id: "repository-static-quality",
        verdict: "pass",
        assertions_total: 2,
      });
      const module = await loadModule();

      await expect(
        module.main(["repository-static-quality", "--trigger", "pre-release"], {
          registryPath,
          runAction,
        }),
      ).resolves.toEqual({
        gate_id: "repository-static-quality",
        verdict: "pass",
        assertions_total: 2,
      });
      expect(runAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "run",
          trigger: "pre-release",
          dry_run: true,
        }),
        expect.any(Object),
        expect.objectContaining({
          workspace: expect.objectContaining({
            providers: expect.objectContaining({
              "repository-quality": expect.any(Function),
            }),
            provider_capabilities: {
              "repository-quality": { cost_class: "high", network: false },
            },
          }),
        }),
      );
      const provider =
        runAction.mock.calls[0][2].workspace.providers[
          module.REPOSITORY_QUALITY_PROVIDER
        ];
      await expect(
        provider({
          provider: module.REPOSITORY_QUALITY_PROVIDER,
          key: "missing",
        }),
      ).rejects.toThrow("is not declared");
    });
  });

  it("returns help, JSON output, and a blocking failure", async () => {
    const module = await loadModule();
    await expect(module.main(["--help"])).resolves.toHaveProperty("usage");
    await expect(module.main([])).rejects.toThrow("requires a gate id");
    const registryPath = path.join(
      process.cwd(),
      "scripts/release/gate-registry.json",
    );
    const pass = {
      gate_id: "repository-context-quality",
      verdict: "warn",
      assertions_total: 1,
      assertions: [],
    };
    await expect(
      module.main(["repository-context-quality", "--json"], {
        registryPath,
        runAction: vi.fn().mockResolvedValue(pass),
      }),
    ).resolves.toBe(pass);
    await expect(
      module.main(["repository-context-quality"], {
        registryPath,
        runAction: vi.fn().mockResolvedValue({
          ...pass,
          verdict: "block",
          assertions: [{ assertion_id: "failed" }],
        }),
      }),
    ).rejects.toThrow("blocked");
  });

  it("keeps imported and executable entrypoints separate", async () => {
    const module = await loadModule();
    await expect(
      module.runRepositoryAssuranceEntrypoint({ argv: ["node", "other.mjs"] }),
    ).resolves.toBe(false);
    const write = vi.fn();
    await expect(
      module.runRepositoryAssuranceEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/repository-assurance.mjs"),
        ],
        run: vi.fn().mockResolvedValue({ ok: true }),
        write,
      }),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
    const onError = vi.fn();
    await expect(
      module.runRepositoryAssuranceEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/repository-assurance.mjs"),
        ],
        run: vi.fn().mockRejectedValue(new Error("failed")),
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(
      module.runRepositoryAssuranceEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/repository-assurance.mjs"),
          "--help",
        ],
      }),
    ).resolves.toBe(true);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("usage"));
    stdout.mockRestore();

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit called");
    }) as typeof process.exit);
    await expect(
      module.runRepositoryAssuranceEntrypoint({
        argv: [
          "node",
          path.resolve("scripts/release/repository-assurance.mjs"),
        ],
      }),
    ).rejects.toThrow("exit called");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("requires a gate id"),
    );
    exit.mockRestore();
    consoleError.mockRestore();
  });
});
