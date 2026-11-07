import {
  defineExtension,
  type ExtensionCapability,
  type ExporterArtifactOutputContract,
  type FlagDefinition,
  type SchemaFieldDefinition,
  type SchemaItemTypeCommandOptionPolicyDefinition,
  type SchemaItemTypeOptionDefinition,
} from "@unbrained/pm-cli/sdk/authoring";
import {
  PM_TOOL_ACTIONS,
  parseMutationReceipt,
  type PmMutationReceipt,
  type PmToolAction,
} from "@unbrained/pm-cli/sdk/contracts";
import { PmClient, type ItemDocument } from "@unbrained/pm-cli/sdk/core";
import { listAllItemMetadataLight } from "@unbrained/pm-cli/sdk/runtime";
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
// pm-gh1667: a type named by a public function signature is importable by name from the entrypoint that exports the function.
import type { ProjectedGraphResult } from "@unbrained/pm-cli/sdk/graph";
import type { ItemScalarConflictResolution, MergeDecisionReceipt } from "@unbrained/pm-cli/sdk/merge";
import type {
  HistoryEntry,
  ItemScalarConflictResolution as AggregateConflictResolution,
  ProjectedGraphResult as AggregateProjectedGraphResult,
} from "@unbrained/pm-cli/sdk";
import type { ExtensionActivationResult } from "@unbrained/pm-cli/sdk/testing";
import {
  assertExtensionBlueprint,
  type ExtensionTestHarness,
} from "@unbrained/pm-cli/sdk/testing";

const action: PmToolAction = PM_TOOL_ACTIONS[0];
const receipt: PmMutationReceipt = parseMutationReceipt(
  '{"id":"pm-demo","status":"open","changed_field_count":1}',
);
const capability: ExtensionCapability = "commands";
const client = new PmClient({ noExtensions: true });
const lightMetadata = client.listAllItemMetadataLight();
const lightMetadataPrimitive = listAllItemMetadataLight("/tmp/.agents/pm");
const extension = defineExtension({ activate: () => undefined });
const artifactOutput: ExporterArtifactOutputContract = {
  channel: "stdout",
  media_type: "application/json",
};
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
void receipt;
void capability;
void client;
void lightMetadata;
void lightMetadataPrimitive;
void extension;
void artifactOutput;
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

const projectedGraph: (...args: Parameters<typeof runGraph>) => Promise<ProjectedGraphResult> = runGraph;
const aggregateGraph: AggregateProjectedGraphResult | undefined = undefined as ProjectedGraphResult | undefined;
const conflictResolution: ItemScalarConflictResolution = "preferred_side";
const receiptResolution: MergeDecisionReceipt["conflict_resolution"] = conflictResolution;
const aggregateResolution: AggregateConflictResolution = receiptResolution;
declare const historyEntry: HistoryEntry;
declare const activation: ExtensionActivationResult;
void projectedGraph;
void aggregateGraph;
void aggregateResolution;
void historyEntry.op;
void activation.commands;

type PublicSubpathContracts =
  | ItemDocument
  | ValidateResult
  | GraphResult
  | ItemDocumentMergeResult
  | ListResult
  | ExtensionTestHarness;

declare const contract: PublicSubpathContracts;
void contract;
