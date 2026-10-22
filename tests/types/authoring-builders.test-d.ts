/** @module tests/types/authoring-builders.test-d Public builder exactness, literals and callback inference (pm-gh1539). */
import {
  defineCommand, defineExtensionManifest, defineFlag, defineItemField,
  defineItemType, defineMigration, definePreflightOverride, defineProjectProfile,
  defineRendererOverride, defineSearchProvider, defineVectorStoreAdapter,
  type ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";
import { defineCommand as rootCommand, readRuntimeFieldOptionValue, resolveRuntimeFieldRegistry } from "@unbrained/pm-cli/sdk";

declare const api: ExtensionApi;
declare const registry: ReturnType<typeof resolveRuntimeFieldRegistry>;
const customValue: unknown = readRuntimeFieldOptionValue({ customer: "acme" }, registry.definitions[0]);
void customValue;
const command = defineCommand({
  name: "probe ping", action: "probe-ping", examples: ["pm probe ping"],
  flags: [{ long: "--verbose", value_type: "boolean" }],
  read_output: { row_keys: ["items"] },
  run: (context) => {
    const args: string[] = context.args;
    // @ts-expect-error contextual typing must not silently become any
    const invalid: number = context.args;
    void invalid;
    return { args };
  },
});
const commandName: "probe ping" = command.name;
const commandAction: "probe-ping" = command.action;
const example: "pm probe ping" = command.examples[0];
api.registerCommand(command);
const rootName: "root ping" = rootCommand({ name: "root ping" }).name;
// @ts-expect-error misspelled command description must fail before activation
defineCommand({ name: "bad", descripton: "typo" });
// @ts-expect-error misspelled read-output declaration must not disappear
rootCommand({ name: "bad", read_ouput: { row_keys: [] } });
const misspelled = { name: "bad", descripton: "typo" };
// @ts-expect-error exactness also applies to separately authored definitions
defineCommand(misspelled);

const manifest = defineExtensionManifest({ name: "probe", version: "1.0.0", entry: "./index.ts", priority: 0, capabilities: ["commands"] });
const manifestName: "probe" = manifest.name;
// @ts-expect-error misspelled manifest metadata
defineExtensionManifest({ ...manifest, prioroty: 1 });
const profile = defineProjectProfile({ name: "probe", title: "Probe", summary: "Probe", types: [], statuses: [], fields: [], workflows: [], config: [], templates: [], packages: [] });
const profileName: "probe" = profile.name;
// @ts-expect-error misspelled profile metadata
defineProjectProfile({ ...profile, summery: "typo" });
const flag = defineFlag({ long: "--count", value_type: "number", value_validation: "strict", repeatable: true });
const flagName: "--count" = flag.long;
const itemType = defineItemType({ name: "Incident", folder: "incidents", aliases: ["incident"] });
const typeName: "Incident" = itemType.name;
const alias: "incident" = itemType.aliases[0];
const field = defineItemField({ name: "customer", type: "string", values: ["first"] });
const fieldName: "customer" = field.name;
const migration = defineMigration({ id: "first", run: (context) => { void context; } });
const migrationId: "first" = migration.id;
const search = defineSearchProvider({ name: "search", query: async (context) => { void context; return []; } });
const searchName: "search" = search.name;
const vector = defineVectorStoreAdapter({ name: "vector", query: async (context) => { void context; return []; } });
const vectorName: "vector" = vector.name;
const preflight = definePreflightOverride({ commands: ["create"], run: (context) => { void context; return {}; } });
const preflightCommand: "create" = preflight.commands[0];
const renderer = defineRendererOverride({ commands: ["get"], run: (context) => { void context; return null; } });
const rendererCommand: "get" = renderer.commands[0];
// @ts-expect-error sibling flag definitions reject misspelled metadata
defineFlag({ long: "--bad", value_typo: "string" });
// @ts-expect-error sibling item type definitions reject misspelled metadata
defineItemType({ name: "Incident", foldre: "incidents" });
// @ts-expect-error sibling field definitions reject misspelled metadata
defineItemField({ name: "customer", type: "string", optionality: true });
// @ts-expect-error sibling migration definitions reject misspelled metadata
defineMigration({ id: "bad", descripton: "typo" });
// @ts-expect-error sibling provider definitions reject misspelled metadata
defineSearchProvider({ name: "bad", qurey: async () => [] });
// @ts-expect-error sibling adapter definitions reject misspelled metadata
defineVectorStoreAdapter({ name: "bad", upsertt: async () => undefined });
// @ts-expect-error scoped preflight definitions reject misspelled ownership
definePreflightOverride({ commands: ["create"], commandz: [], run: () => ({}) });
// @ts-expect-error scoped renderer definitions reject misspelled ownership
defineRendererOverride({ commands: ["get"], commandz: [], run: () => null });
void [commandName, commandAction, example, rootName, manifestName, profileName, flagName, typeName, alias, fieldName, migrationId, searchName, vectorName, preflightCommand, rendererCommand];
