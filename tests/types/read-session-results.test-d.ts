/** Compile-time consumer proof for session references, declared row paths and ordinary reads. */
import {
  PmClient, applyReadOutputDimensions, isReadOutputBudgetExceeded, isReadOutputSessionReference,
  type PmReadOutputResult, type ContextResult, type SearchHit,
} from "../../src/sdk/index.js";
import { isReadOutputSessionReference as coreSessionReference } from "../../src/sdk/core.js";
import type { PmReadOutputSessionResult as CoreSessionResult } from "../../src/sdk/core.js";
import type { PmReadOutputSessionResult as ContractsSessionResult } from "../../src/sdk/contracts.js";

declare const client: PmClient;
declare const maybeSession: { outputSession?: string; after?: string };
declare const sharedSession: CoreSessionResult<ContextResult> & ContractsSessionResult<ContextResult>;
void [sharedSession, coreSessionReference];

/** Session-capable client results require row narrowing after omission narrowing. */
async function consumeSessions(): Promise<void> {
  const page = await client.context(maybeSession);
  if (!isReadOutputBudgetExceeded(page)) {
    for (const row of page.high_level) {
      // @ts-expect-error session references intentionally omit prose
      const unsafeTitle: string = row.title;
      if (isReadOutputSessionReference(row)) {
        const reference: string = row.context_ref;
        void reference;
      } else {
        const title: string = row.title;
        void title;
      }
      void unsafeTitle;
    }
  }
  const ordinary = await client.context();
  const budgeted = await client.context({ outputBudget: 10_000 });
  const noSession = await client.context({ outputSession: undefined });
  const title: string | undefined = ordinary.high_level[0]?.title;
  if (!isReadOutputBudgetExceeded(noSession)) {
    const absentTitle: string | undefined = noSession.high_level[0]?.title;
    void absentTitle;
  }
  if (!isReadOutputBudgetExceeded(budgeted)) {
    const budgetTitle: string | undefined = budgeted.high_level[0]?.title;
    void budgetTitle;
  }
  void title;
}

declare const context: PmReadOutputResult<ContextResult>;
if (!isReadOutputBudgetExceeded(context)) {
  // @ts-expect-error generic output shaping may suppress previously served facts
  void context.low_level[0]?.title;
  const id: string | undefined = context.low_level[0]?.id;
  void id;
}

declare const hit: SearchHit;
const shaped = applyReadOutputDimensions("search", { outputSession: "session" }, { items: [hit], count: 1 });
if (!isReadOutputBudgetExceeded(shaped)) {
  const row = shaped.items[0]!;
  // @ts-expect-error a suppressed search hit has no nested item
  void row.item.title;
  if (isReadOutputSessionReference(row)) {
    const reference: string = row.context_ref;
    void reference;
  } else {
    const score: number = row.score;
    const title: string = row.item.title;
    void [score, title];
  }
}

const nested = applyReadOutputDimensions("graph", {}, {
  row_contract: { row_keys: ["data.rows"] as const },
  data: { rows: { first: { id: "pm-one", title: "Work" } }, label: "Graph" },
  metadata: [{ id: "metadata", title: "Unchanged" }],
});
if (!isReadOutputBudgetExceeded(nested)) {
  const row = nested.data.rows.first;
  // @ts-expect-error a declared object-map row can be a reference
  void row.title;
  if (!isReadOutputSessionReference(row)) {
    const title: string = row.title;
    void title;
  }
  const label: string = nested.data.label;
  const metadataTitle: string | undefined = nested.metadata[0]?.title;
  void [label, metadataTitle];
}
void consumeSessions;

declare const dynamicPaths: { row_contract: { row_keys: string[] }; data: { rows: { first: { id: string; title: string } } } };
const dynamic = applyReadOutputDimensions("graph", {}, dynamicPaths);
if (!isReadOutputBudgetExceeded(dynamic)) {
  // @ts-expect-error a runtime-declared nested map can replace a fact with a reference
  void dynamic.data.rows.first.title;
}
declare const optionalPaths: { row_contract?: { row_keys: readonly ["data.rows"] }; data: { rows: { first: { id: string; title: string } } } };
const optional = applyReadOutputDimensions("graph", {}, optionalPaths);
if (!isReadOutputBudgetExceeded(optional)) {
  // @ts-expect-error an optional contract can still select a nested row map
  void optional.data.rows.first.title;
}

const overlapping = applyReadOutputDimensions("graph", {}, {
  row_contract: { row_keys: ["data", "data.rows"] as const },
  data: { rows: [{ item_id: "pm-one", title: "Work" }] },
});
if (!isReadOutputBudgetExceeded(overlapping)) {
  // @ts-expect-error a nested row path remains session-capable when its parent is also declared
  void overlapping.data.rows[0]?.title;
}

declare const arrayMaps: { first: { id: string; title: string } }[];
const indexed = applyReadOutputDimensions("graph", {}, {
  row_contract: { row_keys: ["data.0"] as const }, data: arrayMaps,
});
if (!isReadOutputBudgetExceeded(indexed)) {
  // @ts-expect-error a numeric path selects a map inside a general array
  void indexed.data[0]?.first.title;
}
