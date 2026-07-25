import {
  defineExtension,
  type ExtensionCapability,
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

void action;
void capability;
void client;
void extension;
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
