/** Compile-time contracts for sparse producer pages and union-shaped read options. */
import {
  PmClient,
  context,
  list,
  search,
  isReadOutputBudgetExceeded,
  type ListOptions,
  type ListResult,
  type ContextResult,
  type SearchResult,
  type PmReadOutputResultFor,
} from "../../src/sdk/index.js";
import type { PmReadOutputProducerContinuation as CoreContinuation } from "../../src/sdk/core.js";
import type { PmReadOutputProducerContinuation as ContractsContinuation } from "../../src/sdk/contracts.js";

declare const continuation: CoreContinuation<ListResult> & ContractsContinuation<ListResult>;
const reference: "reference" = continuation.continuation_contract.metadata;
void reference;

declare const client: PmClient;
declare const cursor: string;
declare const maybeOptions: ListOptions;
declare const dynamicOptions: Record<string, unknown>;
declare const unionOptions: { limit: string } | { outputBudget: number };
declare const sessionOptions: { limit: string } | { outputSession: string };
declare const outputCursorOptions: { limit: string } | { outputCursor: string };

const first: Promise<ListResult> = client.list();
const freeFirst: Promise<ListResult> = list();
const explicitEmpty: Promise<ListResult> = client.list({});
const initialContext: Promise<ContextResult> = client.context();
const freeContext: Promise<ContextResult> = context();
const initialSearch: Promise<SearchResult> = client.search("work");
const freeSearch: Promise<SearchResult> = search("work");
void [first, freeFirst, explicitEmpty, initialContext, freeContext, initialSearch, freeSearch];

/** Require narrowing before using repeated metadata on every producer read form. */
async function checkProducerPages(): Promise<void> {
  const page = await client.list({ after: cursor });
  const dynamicPage = await client.list(dynamicOptions);
  if (!isReadOutputBudgetExceeded(dynamicPage)) {
    // @ts-expect-error generic records can carry a producer cursor
    const dynamicCount: number = dynamicPage.count;
    void dynamicCount;
  }
  const firstWithoutCursor = await client.list({ after: undefined, limit: "1" });
  const initialCount: number = firstWithoutCursor.count;
  const optionalCount: number | undefined = page.count;
  // @ts-expect-error continuation metadata may be absent
  const count: number = page.count;
  // @ts-expect-error continuation pages do not guarantee the first-page projection
  void page.projection.fields;
  // @ts-expect-error continuation pages do not guarantee a completeness certificate
  void page.completeness.status;
  // @ts-expect-error producer continuation pages reference the initial omission receipt
  void page.omission_receipt.has_omissions;
  if ("continuation_contract" in page) {
    const metadata: "reference" = page.continuation_contract.metadata;
    const restore: "omit --after" = page.continuation_contract.restore_with;
    const fingerprint: string = page.continuation_contract.fingerprint;
    void [metadata, restore, fingerprint];
  }
  const maybe = await client.list(maybeOptions);
  if (!isReadOutputBudgetExceeded(maybe)) {
    // @ts-expect-error an optional cursor can still request sparse metadata
    const maybeCount: number = maybe.count;
    void maybeCount;
  }
  const freePage = await list({ after: cursor });
  // @ts-expect-error standalone convenience reads share the same result contract
  const freeCount: number = freePage.count;
  for (const read of [client.search("work", { after: cursor }), search("work", { after: cursor })]) {
    const hits = await read;
    // @ts-expect-error search continuations may omit the first-page count
    const hitCount: number = hits.count;
    void hitCount;
  }
  for (const read of [client.context({ after: cursor }), context({ after: cursor })]) {
    const snapshot = await read;
    // @ts-expect-error context continuations may omit first-page time metadata
    const now: string = snapshot.now;
    void now;
  }
  void [count, optionalCount, freeCount, initialCount];
}

/** Retain every possible omission while allowing useful rows after narrowing. */
async function checkUnionOptions(): Promise<void> {
  for (const read of [client.list(unionOptions), client.list(sessionOptions), client.list(outputCursorOptions)]) {
    const result = await read;
    // @ts-expect-error every possible omission must be narrowed before accessing rows
    void result.items;
    if (isReadOutputBudgetExceeded(result)) {
      const reason: "requested_budget_infeasible" = result.output_budget_exceeded.reason;
      void reason;
    } else {
      void result.items;
    }
  }
}

declare const combined: PmReadOutputResultFor<ListResult, { after: string } | { outputBudget: number }>;
// @ts-expect-error a budget-capable union cannot promise useful rows
void combined.items;
void [checkProducerPages, checkUnionOptions];
