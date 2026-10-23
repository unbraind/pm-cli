/**
 * @module tests/types/read-output-contracts.test-d
 *
 * Compile-time proof that universal read results require budget-omission
 * narrowing and that every narrowed SDK entrypoint exports the contract types
 * referenced by its public signatures.
 */
import {
  PmClient,
  applyReadOutputDimensions,
  isReadOutputBudgetExceeded,
  type GetResult,
  type Dependency,
  type ListedItem,
  type ListResult,
  type PmReadOutputOptions,
  type PmReadOutputResult,
  type PmReadOutputSessionReceipt,
  type ContextEvaluationReader,
  runContextEvaluationScenario,
  list, context, search, get,
  type OutputOmissionReceipt, type PmReadOutputReceipt, type PmReadOutputTruncationDisclosure,
  type PmReadOutputMetadata,
} from "../../src/sdk/index.js";
import type {
  PmReadOutputOptions as CoreReadOutputOptions,
  PmReadOutputSessionState as CoreReadOutputSessionState,
} from "../../src/sdk/core.js";
import type {
  PmReadOutputSessionReceipt as ContractsReadOutputSessionReceipt,
  PmReadOutputSessionState as ContractsReadOutputSessionState,
} from "../../src/sdk/contracts.js";
import type {
  PmContextIntentContract,
  PmErrorCodeContract,
  PmReadOutputOptions as RuntimeReadOutputOptions,
  PmReadOutputSessionReceipt as RuntimeReadOutputSessionReceipt,
  PmReadOutputSurfaceContract,
  PmReadOutputSessionState as RuntimeReadOutputSessionState,
} from "../../src/sdk/runtime.js";
import type { PmReadOutputMetadata as QueryReadMetadata, ListResult as QueryListResult } from "../../src/sdk/query.js";

declare const rawQuery: QueryListResult;
const rawOmissions: OutputOmissionReceipt | undefined = rawQuery.omission_receipt;
const rawBudget: PmReadOutputReceipt | undefined = rawQuery.read_output;
declare const projectedMetadata: PmReadOutputMetadata & QueryReadMetadata;
const projectedOmissions: boolean = projectedMetadata.omission_receipt.has_omissions;
void [rawOmissions, rawBudget, projectedOmissions];

const options = {
  outputInclude: "id,title",
  outputLimit: 2,
  outputBudget: 256,
  outputFormat: "toon",
  outputCursor: "opaque-cursor",
} satisfies PmReadOutputOptions &
  CoreReadOutputOptions &
  RuntimeReadOutputOptions;

const result = applyReadOutputDimensions("list", options, {
  items: [{ id: "pm-one" }],
});

declare const getResult: GetResult;
const projectedItemId: string = getResult.item.id;
void projectedItemId;

declare const dependency: Dependency;
declare const listedItem: ListedItem;
const readTimestamp: string | undefined = dependency.created_at;
const listedTimestamp: string | undefined = listedItem.dependencies?.[0]?.created_at;
const projectedTimestamp: string | undefined = getResult.item.dependencies?.[0]?.created_at;
void [readTimestamp, listedTimestamp, projectedTimestamp];
// @ts-expect-error supported legacy dependencies have no creation timestamp
dependency.created_at.toLowerCase();
// @ts-expect-error full SDK list reads preserve missing legacy timestamps
listedItem.dependencies?.[0]?.created_at.toLowerCase();
// @ts-expect-error get projections require timestamp narrowing as well
getResult.item.dependencies?.[0]?.created_at.toLowerCase();

// @ts-expect-error useful result fields are unsafe until the omission branch is narrowed
const unsafeItems = result.items;
void unsafeItems;

if (isReadOutputBudgetExceeded(result)) {
  const reason: "requested_budget_infeasible" =
    result.output_budget_exceeded.reason;
  void reason;
} else {
  const firstId: string | undefined = result.items[0]?.id;
  void firstId;
}

declare const intentContract: PmContextIntentContract;
declare const surfaceContract: PmReadOutputSurfaceContract;
declare const errorContract: PmErrorCodeContract;
void intentContract;
void surfaceContract;
void errorContract;

declare const sessionState: CoreReadOutputSessionState &
  ContractsReadOutputSessionState &
  RuntimeReadOutputSessionState;
void sessionState;

declare const typedReadResult: PmReadOutputResult<ListResult>;
const typedSessionReceipt:
  | (PmReadOutputSessionReceipt &
      ContractsReadOutputSessionReceipt &
      RuntimeReadOutputSessionReceipt)
  | undefined =
  typedReadResult.read_session;
void typedSessionReceipt;

const client = new PmClient();
const evaluationReader: ContextEvaluationReader = client;
void runContextEvaluationScenario({
  id: "sdk-reader", surface: "context", judgments: {}, token_budget: 1000,
  rationale: "Public client composes without an adapter or casts.",
}, evaluationReader);
const ordinaryClientRead: Promise<ListResult> = client.list({ limit: "2" });
const budgetedClientRead: Promise<PmReadOutputResult<ListResult>> = client.list(
  {
    outputBudget: 256,
  },
);
const sessionClientRead: Promise<PmReadOutputResult<ListResult>> = client.list({
  outputSession: {
    version: 1,
    id: "orientation",
    token_budget: 2_000,
    spent_tokens: 0,
    seen_item_ids: [],
  },
});
const cursorClientRead: Promise<PmReadOutputResult<ListResult>> = client.list({
  outputCursor: "opaque-cursor",
});
void ordinaryClientRead;
void budgetedClientRead;
void sessionClientRead;
void cursorClientRead;

/** Finalized first pages expose shared receipts while preserving their required query fields. */
async function consumeReadReceipts(): Promise<void> {
  const pages = [await list(), await context(), await search("anchor"), await get("pm-anchor")];
  const clientPages = [await client.list(), await client.context(), await client.search("anchor"), await client.get("pm-anchor")];
  for (const page of [...pages, ...clientPages]) {
    const omissions: OutputOmissionReceipt = page.omission_receipt;
    const budget: PmReadOutputReceipt | undefined = page.read_output;
    const truncation: PmReadOutputTruncationDisclosure | undefined = page.output_budget_truncation;
    const omitted: boolean = page.omission_receipt.has_omissions;
    void [omissions, budget, truncation, omitted];
  }
}
void consumeReadReceipts;
