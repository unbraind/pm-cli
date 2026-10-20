import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/runtime.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";
import { writeTestExtension } from "../../helpers/extensions.js";

interface AuthorScenario {
  environment?: string;
  invocation?: string;
  override?: string;
  optionsAuthor?: string;
  actor: string;
  source: string;
}

interface AuthorProbeResult {
  id: string;
  invocationAuthor?: string;
}

async function invokeAuthorProbe(context: TempPmContext, surface: "cli" | "sdk", scenario: AuthorScenario): Promise<AuthorProbeResult> {
  if (surface === "sdk") {
    const client = new PmClient({ pmRoot: context.pmPath, author: scenario.invocation });
    return await client.run("author probe", { options: { override: scenario.override, ...(scenario.optionsAuthor === undefined ? {} : { author: scenario.optionsAuthor }) } }) as AuthorProbeResult;
  }
  const command = context.runCli([
    "author", "probe", "--json",
    ...(scenario.invocation === undefined ? [] : ["--author", scenario.invocation]),
    ...(scenario.override === undefined ? [] : ["--override", scenario.override]),
  ], { expectJson: true });
  expect(command.code, command.stderr).toBe(0);
  return command.json as AuthorProbeResult;
}

describe("injected extension author attribution (pm-65srr0)", () => {
  it.each(["cli", "sdk"] as const)("preserves author precedence and scope through %s dispatch", async (surface) => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "author-probe"),
        name: "author-probe",
        manifestOverrides: { capabilities: ["commands", "schema"] },
        entrySource: `export default { activate(api) {
          api.registerCommand({ name: "author probe", flags: [{ long: "--override", value_name: "id", value_type: "string" }], run: async ({ sdk, options, global }) => {
            const input = { type: "Task", title: "Extension author probe", createMode: "progressive" };
            const created = options.override
              ? await sdk.client.run("create", { author: options.override, options: input, fullChangedFields: true })
              : await sdk.client.create(input);
            await sdk.mutateWorkspaceSettings({ operationId: created.item.id, mutate: (current) => ({ ...current, ux: { ...current.ux, deprecation_hints: !current.ux.deprecation_hints } }) });
            return { id: created.item.id, invocationAuthor: global.author };
          } });
        } };`,
      });
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      await writeFile(settingsPath, JSON.stringify({ ...settings, author_default: "workspace-actor" }));
      const scenarios: AuthorScenario[] = [
        { environment: undefined, invocation: undefined, override: undefined, actor: "workspace-actor", source: "configured" },
        { environment: "environment-actor", invocation: undefined, override: undefined, actor: "environment-actor", source: "asserted" },
        { environment: "environment-actor", invocation: "invocation-actor", override: undefined, actor: "invocation-actor", source: "asserted" },
        { environment: "environment-actor", invocation: "invocation-actor", override: "call-actor", actor: "call-actor", source: "asserted" },
        { environment: undefined, invocation: undefined, override: undefined, actor: "workspace-actor", source: "configured" },
      ];
      if (surface === "sdk") scenarios.push({ environment: "environment-actor", invocation: "client-default", optionsAuthor: "options-actor", actor: "options-actor", source: "asserted" });
      for (const scenario of scenarios) {
        if (scenario.environment === undefined) {
          delete process.env.PM_AUTHOR;
          delete context.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = scenario.environment;
          context.env.PM_AUTHOR = scenario.environment;
        }
        const result = await invokeAuthorProbe(context, surface, scenario);
        expect(result.invocationAuthor).toBe(scenario.optionsAuthor ?? scenario.invocation);
        const history = (await readFile(path.join(context.pmPath, "history", `${result.id}.jsonl`), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(history[0]).toMatchObject({ author: scenario.actor, author_source: scenario.source });
        const workspace = (await readFile(path.join(context.pmPath, "history", "_workspace.jsonl"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(workspace.at(-1)).toMatchObject({
          author: scenario.optionsAuthor ?? scenario.invocation ?? scenario.environment ?? "workspace-actor",
          author_source: scenario.invocation === undefined && scenario.environment === undefined ? "configured" : "asserted",
        });
        expect(process.env.PM_AUTHOR).toBe(scenario.environment);
      }
    });
  });
});
