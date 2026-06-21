/**
 * @module cli/commands/extension/scaffold
 *
 * Implements extension package-management support for Scaffold.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { normalizeManagedDirectoryName } from "./shared.js";

// Safe compatibility floor emitted into scaffolded manifests. Mirrors the
// first-party package manifests (pm-nf2q): every current 2026.5.x CLI
// satisfies it, and it models the field for external authors. manifest_version
// tracks the manifest schema generation (currently 1).
const SCAFFOLD_MANIFEST_VERSION = 1;
const SCAFFOLD_PM_MIN_VERSION = "2026.5.0";
const SCAFFOLD_DECLARED_PERMISSIONS = {
  fs_read: false,
  fs_write: false,
  network: false,
  env_read: false,
  env_write: false,
  process_spawn: false,
};

interface ExtensionScaffoldFileResult {
  path: string;
  status: "created" | "unchanged";
}

interface ExtensionScaffoldResult {
  extension_name: string;
  command_name: string;
  target_path: string;
  created_directory: boolean;
  files: ExtensionScaffoldFileResult[];
}


/**
 * Implements build starter extension scaffold files for the public runtime surface of this module.
 */
export function buildStarterExtensionScaffoldFiles(
  extensionName: string,
  commandName: string,
  vocabulary: "extension" | "package",
): Record<string, string> {
  const packageName = `pm-${extensionName}`;
  const manifest = `${JSON.stringify(
    {
      name: extensionName,
      version: "0.1.0",
      entry: "./index.js",
      manifest_version: SCAFFOLD_MANIFEST_VERSION,
      pm_min_version: SCAFFOLD_PM_MIN_VERSION,
      trusted: true,
      sandbox_profile: "strict",
      permissions: { ...SCAFFOLD_DECLARED_PERMISSIONS },
      capabilities: ["commands"],
    },
    null,
    2,
  )}\n`;
  // Keep scaffolds dependency-light by default: even package mode can be
  // installed before peer dependencies are materialized in the generated root.
  // The JSDoc import preserves editor narrowing without forcing the runtime
  // loader to resolve @unbrained/pm-cli/sdk from a freshly generated scaffold.
  const entrypoint = [
    '/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */',
    "export function activate(api) {",
    "  api.registerCommand({",
    `    name: ${JSON.stringify(commandName)},`,
    '    description: "Starter scaffold command. Replace with your own behavior.",',
    "    run: async (context) => ({",
    "      ok: true,",
    `      source: ${JSON.stringify(extensionName)},`,
    "      command: context.command,",
    '      message: "Starter extension scaffold is active.",',
    "    }),",
    "  });",
    "}",
    "",
    "export default {",
    "  activate,",
    "};",
    "",
  ].join("\n");
  if (vocabulary === "package") {
    const packageJson = `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        keywords: ["pm-package"],
        // `node --test` runs the colocated *.test.js sample against the peer SDK
        // testing helpers; no extra dev-dependency or test runner is required.
        scripts: {
          test: "node --test",
        },
        peerDependencies: {
          "@unbrained/pm-cli": "*",
        },
        pm: {
          aliases: [extensionName],
          extensions: ["."],
          docs: ["README.md"],
          examples: ["README.md"],
          catalog: {
            display_name: extensionName,
            category: "workflow",
            summary: "Starter pm package scaffold.",
            tags: ["starter"],
          },
        },
      },
      null,
      2,
    )}\n`;
    // node:test sample: demonstrates validating command registration with the
    // SDK testing helpers without adding a third-party test runner. Uses the
    // package's own `commands` capability scaffold as the unit under test.
    const sampleTest = [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { activateExtensionForTest, assertRegisteredCommandContract } from "@unbrained/pm-cli/sdk/testing";',
      'import extension from "./index.js";',
      "",
      `test(${JSON.stringify(`${extensionName} registers its starter command`)}, async () => {`,
      "  // `capabilities` mirrors manifest.json so the in-memory activation grants",
      "  // the `commands` capability the entrypoint relies on.",
      "  const activation = await activateExtensionForTest(extension, {",
      `    name: ${JSON.stringify(extensionName)},`,
      '    capabilities: ["commands"],',
      "  });",
      "  // assertRegisteredCommandContract throws if the command is not",
      "  // registered, so reaching here already proves the wiring; assert on the",
      "  // returned definition to demonstrate inspecting registered metadata.",
      "  const registered = assertRegisteredCommandContract(activation.registrations, {",
      `    command: ${JSON.stringify(commandName)},`,
      `    extensionName: ${JSON.stringify(extensionName)},`,
      "  });",
      '  assert.equal(typeof registered.command.description, "string");',
      "});",
      "",
    ].join("\n");
    const gitignore = ["node_modules/", "*.log", ""].join("\n");
    const packageReadme = [
      `# ${packageName}`,
      "",
      "Generated by `pm package init`.",
      "",
      "## Included Files",
      "- `package.json`: package metadata, `test` script, and `pm` resource manifest.",
      "- `manifest.json`: extension metadata and capabilities.",
      "- `index.js`: starter command registration using the `commands` capability.",
      "- `index.test.js`: sample `node:test` suite using the SDK testing helpers.",
      "- `.gitignore`: ignores `node_modules/` and log files.",
      "",
      "## Quick Start",
      "```bash",
      "pm install --project <package-path>",
      `pm ${commandName}`,
      "pm package doctor --project --detail summary",
      "```",
      "",
      "## Validate the Package",
      "Install the peer SDK once, then run the colocated sample test:",
      "```bash",
      "npm install",
      "npm test",
      "```",
      "`npm test` runs `node --test`, which executes `index.test.js` against the",
      "`@unbrained/pm-cli/sdk/testing` helpers — no extra test runner required.",
      "",
      "## Compatibility Bounds",
      "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
      `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
      `- \`pm_min_version\` (string): lowest pm CLI version that may load this package. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the package on older CLIs.`,
      "- `pm_max_version` (string, optional): highest pm CLI version that may load this package. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the package when the CLI exceeds this bound.",
      "",
      "## Policy Metadata",
      "The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: \"strict\"`, and all six permission keys as `false`. Keep that least-privilege shape for pure packages; relax only the specific permission your package actually needs and verify with `pm package doctor --project --detail deep --trace`.",
      "",
      "## Notes",
      "- Keep simple starter runtime behavior at the package root so local installs work without dependency bootstrapping.",
      "- Move larger runtimes into subdirectories only after adding package dependencies and validating `pm package doctor`.",
      "- Add capabilities to the extension manifest only when the entrypoint uses the matching SDK API.",
      "- Use `@unbrained/pm-cli/sdk` as the public SDK import for richer package runtimes.",
      "",
    ].join("\n");
    return {
      "package.json": packageJson,
      "manifest.json": manifest,
      "index.js": entrypoint,
      "index.test.js": sampleTest,
      ".gitignore": gitignore,
      "README.md": packageReadme,
    };
  }
  const readme = [
    `# ${extensionName}`,
    "",
    "Generated by `pm extension init`.",
    "",
    "## Included Files",
    "- `manifest.json`: extension metadata and capabilities.",
    "- `index.js`: starter command registration using the `commands` capability.",
    "",
    "## Quick Start",
    "```bash",
    "pm extension --install --project <scaffold-path>",
    `pm ${commandName}`,
    "pm extension --doctor --project --detail summary",
    "```",
    "",
    "## Compatibility Bounds",
    "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
    `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
    `- \`pm_min_version\` (string): lowest pm CLI version that may load this extension. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the extension on older CLIs.`,
    "- `pm_max_version` (string, optional): highest pm CLI version that may load this extension. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the extension when the CLI exceeds this bound.",
    "",
    "## Policy Metadata",
    "The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: \"strict\"`, and all six permission keys as `false`. Keep that least-privilege shape for pure extensions; relax only the specific permission your extension actually needs and verify with `pm extension --doctor --project --detail deep --trace`.",
    "",
    "## Notes",
    "- This scaffold uses ESM exports so it works in package scopes with `type: module`.",
    "- Update `manifest.json` capabilities and `index.js` command behavior as your extension evolves.",
    "",
  ].join("\n");
  return {
    "manifest.json": manifest,
    "index.js": entrypoint,
    "README.md": readme,
  };
}

/**
 * Implements scaffold extension project for the public runtime surface of this module.
 */
export async function scaffoldExtensionProject(
  target: string,
  vocabulary: "extension" | "package" = "extension",
): Promise<ExtensionScaffoldResult> {
  const normalizedTarget = target.trim();
  const targetPath = path.resolve(process.cwd(), normalizedTarget);
  const extensionName = normalizeManagedDirectoryName(path.basename(targetPath));
  const commandName = `${extensionName} ping`;
  const scaffoldFiles = buildStarterExtensionScaffoldFiles(extensionName, commandName, vocabulary);

  let createdDirectory = false;
  if (await pathExists(targetPath)) {
    const existingTargetStats = await fs.stat(targetPath);
    if (!existingTargetStats.isDirectory()) {
      throw new PmCliError(
        `Scaffold target "${targetPath}" exists and is not a directory.`,
        EXIT_CODE.CONFLICT,
      );
    }
  } else {
    await fs.mkdir(targetPath, { recursive: true });
    createdDirectory = true;
  }

  for (const [relativePath, content] of Object.entries(scaffoldFiles)) {
    const absolutePath = path.join(targetPath, relativePath);
    if (!(await pathExists(absolutePath))) {
      continue;
    }
    const existingContent = await fs.readFile(absolutePath, "utf8");
    if (existingContent !== content) {
      throw new PmCliError(
        `Scaffold file "${relativePath}" already exists with different content in "${targetPath}". Choose a new target path or remove conflicting files.`,
        EXIT_CODE.CONFLICT,
      );
    }
  }

  const files: ExtensionScaffoldFileResult[] = [];
  for (const [relativePath, content] of Object.entries(scaffoldFiles)) {
    const absolutePath = path.join(targetPath, relativePath);
    if (await pathExists(absolutePath)) {
      files.push({
        path: relativePath,
        status: "unchanged",
      });
      continue;
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    files.push({
      path: relativePath,
      status: "created",
    });
  }

  return {
    extension_name: extensionName,
    command_name: commandName,
    target_path: targetPath,
    created_directory: createdDirectory,
    files,
  };
}
