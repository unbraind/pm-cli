import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function installHostContractExtension(
  pmPath: string,
  source: string,
  capabilities: string[] = ["commands", "renderers", "schema"],
  commands: string[] = ["host probe", "host query", "host silent"],
): Promise<void> {
  const extensionDir = path.join(pmPath, "extensions", "host-contract-test");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify(
      {
        name: "host-contract-test",
        version: "1.0.0",
        entry: "./index.mjs",
        capabilities,
        activation: {
          commands,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(extensionDir, "index.mjs"), source, "utf8");
}

describe("extension host contracts", () => {
  it("audits host-bound settings mutations from a copied extension without a local SDK", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "import { appendFileSync } from 'node:fs';",
          "export default { activate(api) {",
          "  api.hooks.onWrite((context) => appendFileSync(new URL('./write-hooks.log', import.meta.url), `${context.op}\\n`));",
          "  api.registerCommand({",
          "    name: 'host settings',",
          "    flags: [{ long: '--operation-id', value_name: 'id', value_type: 'string' }, { long: '--enabled', value_name: 'value', value_type: 'string' }, { long: '--preview', value_type: 'boolean' }],",
          "    run: ({ sdk, options }) => sdk.mutateWorkspaceSettings({",
          "      operationId: options.operationId, dryRun: options.preview === true,",
          "      mutate: (current) => options.enabled === 'invalid' ? { broken: true } : ({ ...current, ux: { ...current.ux, deprecation_hints: options.enabled === 'true' } }),",
          "    }),",
          "  });",
          "  api.registerCommand({ name: 'host other', run: ({ sdk }) => sdk.mutateWorkspaceSettings({ operationId: 'apply-1', mutate: (current) => ({ ...current, ux: { ...current.ux, deprecation_hints: true } }) }) });",
          "} };",
        ].join("\n"),
        ["commands", "schema", "hooks"],
        ["host settings", "host other"],
      );
      const manifestPath = path.join(context.pmPath, "extensions", "host-contract-test", "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, pm_min_version: "2026.9.28" }, null, 2)}\n`);
      expect(context.runCli(["extension", "adopt-all", "--project", "--json"]).code).toBe(0);
      const settingsPath = path.join(context.pmPath, "settings.json");
      const hookLogPath = path.join(context.pmPath, "extensions", "host-contract-test", "write-hooks.log");
      const before = await readFile(settingsPath, "utf8");
      const preview = context.runCli(
        ["host", "settings", "--operation-id", "preview-1", "--enabled", "false", "--preview", "--json"],
        { expectJson: true },
      );
      expect(preview, preview.stderr).toMatchObject({ code: 0, json: { changed: true, dry_run: true, replayed: false } });
      expect(await readFile(settingsPath, "utf8")).toBe(before);

      const applied = context.runCli(
        ["host", "settings", "--operation-id", "apply-1", "--enabled", "false", "--json"],
        { expectJson: true },
      );
      expect(applied).toMatchObject({ code: 0, json: { changed: true, dry_run: false, replayed: false } });
      const persisted = await readFile(settingsPath, "utf8");
      expect(JSON.parse(persisted)).toMatchObject({ ux: { deprecation_hints: false } });
      const appliedHooks = await readFile(hookLogPath, "utf8");
      expect(appliedHooks).toContain("extension:pm:settings");
      const replay = context.runCli(
        ["host", "settings", "--operation-id", "apply-1", "--enabled", "true", "--json"],
        { expectJson: true },
      );
      expect(replay).toMatchObject({ code: 0, json: { changed: false, replayed: true } });
      expect(await readFile(settingsPath, "utf8")).toBe(persisted);
      expect((await readFile(hookLogPath, "utf8")).split("extension:pm:settings").length)
        .toBe(appliedHooks.split("extension:pm:settings").length);

      const invalid = context.runCli(
        ["host", "settings", "--operation-id", "invalid-1", "--enabled", "invalid", "--json"],
      );
      expect(invalid.code).toBe(2);
      expect(await readFile(settingsPath, "utf8")).toBe(persisted);
      const other = context.runCli(["host", "other", "--json"], { expectJson: true });
      expect(other).toMatchObject({ code: 0, json: { changed: true, replayed: false } });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ ux: { deprecation_hints: true } });
      expect((await readFile(hookLogPath, "utf8")).split("extension:pm:settings")).toHaveLength(3);
      expect(context.runCli(["history", "_workspace", "--verify", "--json"], { expectJson: true }).code).toBe(0);
      const health = context.runCli(["health", "--strict-exit", "--json"], { expectJson: true });
      expect(health.code, JSON.stringify(health.json)).toBe(0);
    });
  });

  it("preserves package-local explain and rejects reserved-flag activation atomically", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(context.pmPath, [
        "export default { activate(api) {",
        "api.registerCommand({ name: 'host query', flags: [{ long: '--explain', value_type: 'boolean' }], run: ({ options }) => ({ localExplanation: options.explain === true }) });",
        "api.registerCommand({ name: 'host silent', run: () => ({ sibling: true }) });",
        "} };",
      ].join("\n"));
      const local = context.runCli(["host", "query", "--explain", "--json"], { expectJson: true });
      expect(local, local.stderr).toMatchObject({ code: 0, json: { localExplanation: true } });
      expect(context.runCli(["host", "silent", "--json"], { expectJson: true })).toMatchObject({ code: 0, json: { sibling: true } });
      const root = context.runCli(["--explain"]);
      expect(root.code).toBe(0);
      expect(root.stdout).not.toContain("localExplanation");
      await installHostContractExtension(context.pmPath, [
        "export default { activate(api) {",
        "api.registerCommand({ name: 'host probe', flags: [{ long: '--json', value_type: 'boolean' }], run: () => ({ invalid: true }) });",
        "api.registerCommand({ name: 'host silent', run: () => ({ sibling: true }) });",
        "} };",
      ].join("\n"));
      const rejected = context.runCli(["host", "probe", "--json"], { cwd: context.tempRoot });
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("host-owned global flag");
      expect(context.runCli(["host", "silent", "--json"], { cwd: context.tempRoot }).code).not.toBe(0);
    });
  });

  it("applies renderer overrides to dynamic extension command results", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'host probe', run: () => ({ hostRendered: true, output: 'raw-json' }) });",
          "    api.registerRenderer('json', ({ result }) => result?.hostRendered ? result.output : null);",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = context.runCli(["host", "probe", "--json"]);

      expect({ code: result.code, stderr: result.stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("raw-json\n");
    });
  });

  it("preserves repeated, comma-joined, and aliased extension list flags", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'host probe',",
          "      flags: [{ long: '--repos', short: '-r', value_name: 'path', value_type: 'string', list: true }],",
          "      run: ({ options }) => ({ repos: options.repos }),",
          "    });",
          "    api.registerRenderer('json', () => null);",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = context.runCli(
        [
          "host",
          "probe",
          "-r",
          "alpha",
          "--repos",
          "beta,gamma",
          "--repos=delta",
          "--json",
        ],
        { expectJson: true },
      );

      expect({ code: result.code, stderr: result.stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      expect(result.json).toEqual({
        repos: ["alpha", "beta", "gamma", "delta"],
      });
    });
  });

  it("passes flag-like variadic content after the end-of-options separator", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'host query',",
          "      arguments: [{ name: 'query', required: true, variadic: true }],",
          "      run: ({ args }) => ({ args }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = context.runCli(
        ["--json", "host", "query", "--", "RETURN", "-h", "--json"],
        { expectJson: true },
      );

      expect(result.code).toBe(0);
      expect(result.json).toEqual({ args: ["RETURN", "-h", "--json"] });
    });
  });

  it("honors the public handled-output suppression protocol", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'host silent', run: () => ({ __pm_suppress_host_output: '@unbrained/pm-cli:suppress-host-output:v1' }) });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = context.runCli(["host", "silent", "--json"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });

  it("keeps declared exporter artifacts byte-clean across formats and global JSON", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_HOST_ARTIFACT_PATH = path.join(
        context.tempRoot,
        "artifact.txt",
      );
      await installHostContractExtension(
        context.pmPath,
        [
          "import { writeFileSync } from 'node:fs';",
          "export default {",
          "  activate(api) {",
          "    api.registerExporter('json-report', async () => { process.stdout.write('{\"rows\":[1,2]}\\n'); return { rows: 2 }; }, { output: { channel: 'stdout', media_type: 'application/json' } });",
          "    api.registerExporter('csv-report', async () => { process.stdout.write('id,title\\n1,alpha\\n'); return { rows: 1 }; }, { output: { channel: 'stdout', media_type: 'text/csv' } });",
          "    api.registerExporter('binary-report', async () => { process.stdout.write(Buffer.from([0, 255, 10])); process.stderr.write('exported 3 bytes\\n'); return { bytes: 3 }; }, { output: { channel: 'stdout', media_type: 'application/octet-stream' } });",
          "    api.registerExporter('file-report', async () => { const artifactPath = process.env.PM_HOST_ARTIFACT_PATH; if (!artifactPath) throw new Error('PM_HOST_ARTIFACT_PATH is required'); writeFileSync(artifactPath, 'file artifact\\n'); return { path: 'artifact.txt' }; }, { output: { channel: 'file', media_type: 'text/plain' } });",
          "  },",
          "};",
          "",
        ].join("\n"),
        ["importers"],
        [
          "json-report export",
          "csv-report export",
          "binary-report export",
          "file-report export",
        ],
      );

      expect(context.runCli(["json-report", "export"]).stdout).toBe(
        '{"rows":[1,2]}\n',
      );
      expect(
        context.runCli(["json-report", "export", "--json"]).stdout,
      ).toBe('{"rows":[1,2]}\n');
      expect(context.runCli(["csv-report", "export"]).stdout).toBe(
        "id,title\n1,alpha\n",
      );

      const binary = spawnSync(
        process.execPath,
        [path.resolve("dist/cli.js"), "binary-report", "export"],
        { cwd: process.cwd(), env: context.env },
      );
      expect(binary.status).toBe(0);
      expect(binary.stdout).toEqual(Buffer.from([0, 255, 10]));
      expect(binary.stderr.toString("utf8")).toBe("exported 3 bytes\n");

      const fileResult = context.runCli(
        ["file-report", "export", "--json"],
        { expectJson: true },
      );
      expect(fileResult).toMatchObject({
        code: 0,
        stderr: "",
        json: { path: "artifact.txt" },
      });
      await expect(
        readFile(path.join(context.tempRoot, "artifact.txt"), "utf8"),
      ).resolves.toBe("file artifact\n");

      const help = context.runCli(["json-report", "export", "--help"]);
      expect(help.stdout).toContain("Artifact bytes are written");
      expect(help.stdout).toContain("exclusively to stdout");
    });
  });

  it("supplies portable workspace coordinates to installed extension commands", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'host probe',",
          "      run: ({ source_workspace_root, repo_root, pm_root_rel }) => ({ source_workspace_root, repo_root, pm_root_rel }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const result = context.runCli(["host", "probe", "--json"], {
        expectJson: true,
      });

      expect(result.code).toBe(0);
      expect(result.json).toEqual({
        source_workspace_root: process.cwd(),
        repo_root: process.cwd(),
      });
    });
  });

  it("rejects extension flags owned by the global host contract", async () => {
    await withTempPmPath(async (context) => {
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'host probe',",
          "      flags: [{ long: '--json', value_type: 'boolean' }],",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
        ["commands", "schema"],
      );

      const doctor = context.runCli(
        ["extension", "doctor", "--project", "--json"],
        { expectJson: true },
      );

      expect(doctor.json).toMatchObject({
        details: {
          summary: {
            activation_failures: [
              {
                name: "host-contract-test",
                error: expect.stringContaining(
                  'host-owned global flag "--json"',
                ),
              },
            ],
          },
        },
      });
    });
  });

  it("surfaces activation causes at unknown-command, doctor, and activate boundaries", async () => {
    await withTempPmPath(async (context) => {
      const workspaceRoot = path.join(context.tempRoot, "workspace");
      const workspacePmRoot = path.join(workspaceRoot, ".agents", "pm");
      await installHostContractExtension(
        workspacePmRoot,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({ name: 'workspace only', run: () => ({ ok: true }) });",
          "  },",
          "};",
          "",
        ].join("\n"),
        ["commands"],
        ["workspace only"],
      );
      await writeFile(
        path.join(workspacePmRoot, "settings.json"),
        `${JSON.stringify({ id_prefix: "pm", item_format: "toon" })}\n`,
        "utf8",
      );
      await installHostContractExtension(
        context.pmPath,
        [
          "export default {",
          "  activate(api) {",
          "    api.registerCommand({",
          "      name: 'host probe',",
          "      flags: [{ long: '--ref', value_name: 'value' }],",
          "      run: () => ({ ok: true }),",
          "    });",
          "  },",
          "};",
          "",
        ].join("\n"),
        ["commands"],
      );

      const unknown = context.runCli(["host", "probe", "--json"], {
        cwd: workspaceRoot,
        expectJson: true,
      });
      expect(unknown.code).toBe(2);

      const doctor = context.runCli(
        ["extension", "doctor", "--project", "--json"],
        { expectJson: true },
      );
      expect(doctor.json).toMatchObject({
        details: {
          summary: {
            activation_failures: [
              {
                name: "host-contract-test",
                error: expect.stringContaining("requires capability 'schema'"),
              },
            ],
          },
        },
      });

      const activate = context.runCli(
        ["extension", "activate", "host-contract-test", "--project", "--json"],
        { expectJson: true },
      );
      expect(activate.json).toMatchObject({
        ok: false,
        details: {
          active: false,
          runtime_active: false,
          activation_failure: {
            name: "host-contract-test",
            error: expect.stringContaining("requires capability 'schema'"),
          },
        },
      });
      const unknownError = JSON.parse(unknown.stderr) as {
        code: string;
        failed_extensions: Array<{ name: string; error: string }>;
      };
      expect(unknownError).toMatchObject({
        code: "unknown_command",
        failed_extensions: expect.arrayContaining([
          expect.objectContaining({
            name: "host-contract-test",
            error: expect.stringContaining("requires capability 'schema'"),
          }),
          expect.objectContaining({
            name: "extension-root-relocation",
            error: expect.stringContaining(
              "--pm-path selects extension discovery as well as item storage",
            ),
          }),
        ]),
      });
    });
  });
});
