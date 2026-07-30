import {
  defineExtension,
  type ExtensionCapability,
  type FlagDefinition,
  type SchemaFieldDefinition,
  type SchemaItemTypeCommandOptionPolicyDefinition,
  type SchemaItemTypeOptionDefinition,
} from "@unbrained/pm-cli/sdk/authoring";
import {
  PM_TOOL_ACTIONS,
  type PmToolAction,
} from "@unbrained/pm-cli/sdk/contracts";
import { PmClient, type ItemDocument } from "@unbrained/pm-cli/sdk/core";
import {
  runValidate,
  type ValidateResult,
} from "@unbrained/pm-cli/sdk/governance";
import { runGraph, type GraphResult } from "@unbrained/pm-cli/sdk/graph";
import {
  mergeItemDocuments,
  type ItemDocumentMergeResult,
} from "@unbrained/pm-cli/sdk/merge";
import { runList, type ListResult } from "@unbrained/pm-cli/sdk/query";
import {
  assertExtensionBlueprint,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

const action: PmToolAction = PM_TOOL_ACTIONS[0];
const capability: ExtensionCapability = "commands";
const client = new PmClient({ noExtensions: true });
const extension = defineExtension({ activate: () => undefined });
const flagDefinition: FlagDefinition = {
  long: "--output",
  value_type: "string",
};
const schemaFieldDefinition: SchemaFieldDefinition = {
  name: "customer",
  type: "string",
};
const schemaOptionPolicy: SchemaItemTypeCommandOptionPolicyDefinition = {
  command: "create",
  option: "customer",
};
const schemaOption: SchemaItemTypeOptionDefinition = { key: "customer" };

// @ts-expect-error misspelled known flag metadata must fail at author time
const invalidFlagDefinition: FlagDefinition = { name: "--output" };
const invalidSchemaFieldDefinition: SchemaFieldDefinition = {
  name: "customer",
  type: "string",
  // @ts-expect-error misspelled schema field metadata must fail at author time
  optionality: true,
};
const invalidSchemaOptionPolicy: SchemaItemTypeCommandOptionPolicyDefinition = {
  command: "create",
  option: "customer",
  // @ts-expect-error misspelled option-policy metadata must fail at author time
  visibility: true,
};
const invalidSchemaOption: SchemaItemTypeOptionDefinition = {
  key: "customer",
  // @ts-expect-error misspelled schema option metadata must fail at author time
  alias: ["client"],
};

void action;
void capability;
void client;
void extension;
void flagDefinition;
void schemaFieldDefinition;
void schemaOptionPolicy;
void schemaOption;
void invalidFlagDefinition;
void invalidSchemaFieldDefinition;
void invalidSchemaOptionPolicy;
void invalidSchemaOption;
void runValidate;
void runGraph;
void mergeItemDocuments;
void runList;
void assertExtensionBlueprint;

type PublicSubpathContracts =
  | ItemDocument
  | ValidateResult
  | GraphResult
  | ItemDocumentMergeResult
  | ListResult
  | ExtensionTestHarness;

declare const contract: PublicSubpathContracts;
void contract;
