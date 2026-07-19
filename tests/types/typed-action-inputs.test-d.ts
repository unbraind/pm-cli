/**
 * @module tests/types/typed-action-inputs.test-d
 *
 * Compile-time contract tests for the typed per-action SDK mutation inputs
 * (GH-601 / pm-x29o). Checked by `pnpm typecheck` via tsconfig.typetests.json:
 * every `@ts-expect-error` line asserts that a field typo or wrong value shape
 * fails `tsc` under strict, and the positive assignments assert the typed
 * surface still accepts every contract-declared key. This file is never
 * executed — a compile is the test.
 */
import type {
  ListProjectedItem,
  PmClientCloseActionOptions,
  PmCloseManyActionOptions,
  PmCreateActionOptions,
  PmUpdateActionOptions,
  PmUpdateManyActionOptions,
} from "../../src/sdk/index.js";

// --- create: contract-declared keys and value shapes compile ---
const createOptions: PmCreateActionOptions = {
  id: "pm-typed-create",
  title: "Typed create",
  description: "contract-derived",
  type: "Task",
  status: "open",
  priority: 1,
  tags: "a,b",
  addTags: ["x", "y"],
  dep: ["id=pm-x29o,kind=related"],
  parent: "pm-usfg",
  risk: "medium",
  confidence: "75",
  author: "type-test",
  message: "typed surface",
  estimatedMinutes: "45",
  file: ["path=src/sdk/runtime.ts,scope=project"],
};
void createOptions;

// @ts-expect-error create: unknown key (typo of "title") must fail tsc
const createTypo: PmCreateActionOptions = { titel: "typo" };
void createTypo;

// @ts-expect-error create: object values are not valid option scalars
const createWrongValue: PmCreateActionOptions = { title: { text: "no" } };
void createWrongValue;

// @ts-expect-error create: non-repeatable options must not accept arrays
const createWrongArray: PmCreateActionOptions = { title: ["a", "b"] };
void createWrongArray;

// @ts-expect-error create: priority accepts the domain's string/number forms, never boolean
const createWrongScalar: PmCreateActionOptions = { priority: true };
void createWrongScalar;

// @ts-expect-error create: MCP tool aliases are not PmClient command-option keys
const createToolAlias: PmCreateActionOptions = { estimate: 45 };
void createToolAlias;

// --- update: contract-declared keys and the schema-level force override compile ---
const updateOptions: PmUpdateActionOptions = {
  status: "in_progress",
  addAc: ["new criterion"],
  removeTags: ["obsolete"],
  replaceDeps: true,
  unset: ["deadline"],
  force: true,
  message: "typed update",
};
void updateOptions;

// @ts-expect-error update: unknown key (typo of "assignee") must fail tsc
const updateTypo: PmUpdateActionOptions = { assginee: "someone" };
void updateTypo;

// --- close: contract-derived keys minus the positional reason/text pair ---
const closeOptions: PmClientCloseActionOptions = {
  resolution: "fixed",
  expectedResult: "typed close options",
  actualResult: "typed close options shipped",
  validateClose: "warn",
  author: "type-test",
};
void closeOptions;

// @ts-expect-error close: the positional reason must not appear in the option bag
const closeReasonLeak: PmClientCloseActionOptions = { reason: "done" };
void closeReasonLeak;

// --- bulk mutations: update/close fields plus selection filters and controls ---
const updateManyOptions: PmUpdateManyActionOptions = {
  filterStatus: "open",
  filterTag: "cleanup",
  ids: "pm-a,pm-b",
  status: "closed",
  dryRun: true,
  noCheckpoint: false,
};
void updateManyOptions;

const closeManyOptions: PmCloseManyActionOptions = {
  ids: "pm-a,pm-b",
  reason: "batch closure",
  resolution: "fixed",
  rollback: false,
};
void closeManyOptions;

// @ts-expect-error close-many: item-content mutation keys (body) are not part of the closure contract
const closeManyWrongKey: PmCloseManyActionOptions = { body: "not allowed" };
void closeManyWrongKey;

// --- projected list rows: typed core fields are string-typed, never unknown ---
declare const projectedRow: ListProjectedItem;
const projectedId: string | undefined = projectedRow.id;
const projectedTitle: string | undefined = projectedRow.title;
const projectedPriority: number | undefined = projectedRow.priority;
void projectedId;
void projectedTitle;
void projectedPriority;
