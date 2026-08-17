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
