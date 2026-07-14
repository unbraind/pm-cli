import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function installHostContractExtension(
  pmPath: string,
  source: string,
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
        capabilities: ["commands", "renderers", "schema"],
        activation: {
          commands: ["host probe", "host query", "host silent"],
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
      expect(result.json).toEqual({ repos: ["alpha", "beta", "gamma", "delta"] });
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
});
