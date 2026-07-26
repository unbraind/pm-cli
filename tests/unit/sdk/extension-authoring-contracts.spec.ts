import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIST_FILTER_EXTENSION_FLAG_DEFINITIONS,
  SEARCH_EXTENSION_FLAG_DEFINITIONS,
  toExtensionFlagDefinitions,
} from "../../../src/sdk/extension-contracts.js";
import {
  SCAFFOLD_CAPABILITIES,
  scaffoldExtensionProject,
} from "../../../src/sdk/extension/scaffold.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("extension authoring contracts", () => {
  it("adapts canonical CLI flags into registration-ready definitions", () => {
    expect(
      toExtensionFlagDefinitions(
        [
          {
            flag: "--match-mode",
            short: "-m",
            aliases: ["--match_mode"],
            description: "Select matching behavior.",
            required: true,
            list: true,
            repeatable: true,
            value_name: "mode",
          },
          { flag: "--compact" },
        ],
        [{ keys: ["matchMode"], aliases: ["match_mode"] }],
      ),
    ).toEqual([
      {
        long: "--match-mode",
        short: "-m",
        description: "Select matching behavior.",
        required: true,
        list: true,
        repeatable: true,
        value_type: "string",
        value_name: "mode",
      },
      {
        long: "--match_mode",
        description: "Select matching behavior.",
        required: true,
        list: true,
        repeatable: true,
        value_type: "string",
        value_name: "mode",
      },
      {
        long: "--compact",
        description: "Standard pm --compact option.",
        value_type: "boolean",
      },
    ]);
    expect(LIST_FILTER_EXTENSION_FLAG_DEFINITIONS.length).toBeGreaterThan(10);
    expect(SEARCH_EXTENSION_FLAG_DEFINITIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          long: "--mode",
          value_type: "string",
        }),
        expect.objectContaining({
          long: "--include-linked",
          value_type: "boolean",
        }),
      ]),
    );
  });

  it.each(SCAFFOLD_CAPABILITIES)(
    "keeps bare and repeated pm-prefixed %s scaffolds package-equivalent",
    async (capability) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), `pm-scaffold-${capability}-`),
      );
      temporaryRoots.push(root);
      const bare = await scaffoldExtensionProject(
        path.join(root, "context-tools"),
        "extension",
        capability,
      );
      const prefixed = await scaffoldExtensionProject(
        path.join(root, "pm-pm-context-tools"),
        "package",
        capability,
      );

      expect(bare).toMatchObject({
        extension_name: "context-tools",
        package_name: "pm-context-tools",
        invocation_command: prefixed.invocation_command,
      });
      expect(prefixed).toMatchObject({
        extension_name: "context-tools",
        package_name: "pm-context-tools",
      });
      expect(bare.files.map((file) => file.path)).toEqual(
        prefixed.files.map((file) => file.path),
      );
      expect(
        JSON.parse(
          await readFile(path.join(bare.target_path, "package.json"), "utf8"),
        ),
      ).toEqual(
        JSON.parse(
          await readFile(
            path.join(prefixed.target_path, "package.json"),
            "utf8",
          ),
        ),
      );
      expect(
        JSON.parse(
          await readFile(path.join(bare.target_path, "manifest.json"), "utf8"),
        ),
      ).toEqual(
        JSON.parse(
          await readFile(
            path.join(prefixed.target_path, "manifest.json"),
            "utf8",
          ),
        ),
      );
    },
  );
});
