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
  type ListResult,
  type PmReadOutputOptions,
  type PmReadOutputResult,
  type PmReadOutputSessionReceipt,
} from "../../src/sdk/index.js";
import type {
  PmReadOutputOptions as CoreReadOutputOptions,
  PmReadOutputSessionState as CoreReadOutputSessionState,
} from "../../src/sdk/core.js";
import type { PmReadOutputSessionState as ContractsReadOutputSessionState } from "../../src/sdk/contracts.js";
import type {
  PmContextIntentContract,
  PmErrorCodeContract,
  PmReadOutputOptions as RuntimeReadOutputOptions,
  PmReadOutputSurfaceContract,
  PmReadOutputSessionState as RuntimeReadOutputSessionState,
} from "../../src/sdk/runtime.js";

const options = {
  outputInclude: "id,title",
  outputLimit: 2,
  outputBudget: 256,
  outputFormat: "toon",
} satisfies PmReadOutputOptions &
  CoreReadOutputOptions &
  RuntimeReadOutputOptions;

const result = applyReadOutputDimensions("list", options, {
  items: [{ id: "pm-one" }],
});

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
const typedSessionReceipt: PmReadOutputSessionReceipt | undefined =
  typedReadResult.read_session;
void typedSessionReceipt;

const client = new PmClient();
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
void ordinaryClientRead;
void budgetedClientRead;
void sessionClientRead;
