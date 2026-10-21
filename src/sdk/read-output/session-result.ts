/**
 * @module sdk/read-output/session-result
 * Models reference replacement at statically declared row paths, with the same
 * top-level array fallback used by envelopes without row declarations.
 */
import type { PmReadOutputSessionReference } from "../read-output-session.js";

type SessionRow<Row> = Row extends { id?: string } | { item_id?: string } | { item?: { id?: string } | null }
  ? Row | PmReadOutputSessionReference
  : Row;

type SessionCollection<Collection> = Collection extends readonly unknown[]
  ? { [Key in keyof Collection]: SessionRow<Collection[Key]> }
  : Collection extends object
    ? { [Key in keyof Collection]: SessionRow<Collection[Key]> }
    : Collection;

type ChildPaths<Paths extends string, Key extends string> =
  Paths extends `${Key}.${infer Tail}` ? Tail : never;

type SessionPaths<Value, Paths extends string> = Value extends object
  ? { [Key in keyof Value]: Key extends string | number
      ? [Extract<Paths, `${Key}`>] extends [never]
        ? [ChildPaths<Paths, `${Key}`>] extends [never]
          ? Value[Key]
          : SessionPaths<Value[Key], ChildPaths<Paths, `${Key}`>>
        : SessionCollection<SessionPaths<Value[Key], ChildPaths<Paths, `${Key}`>>>
      : Value[Key] }
  : Value;

type SessionArrayFallback<Result> = {
  [Key in keyof Result]: Result[Key] extends infer Value
    ? Value extends readonly unknown[] ? SessionCollection<Value> : Value
    : never;
};

type DynamicSessionCollections<Value> = Value extends object
  ? { [Key in keyof Value]: SessionRow<DynamicSessionCollections<Value[Key]>> }
  : Value;

type DynamicSessionPaths<Result> = {
  [Key in keyof Result]: DynamicSessionCollections<Result[Key]>;
};

type DeclaredSessionPaths<Result, Contract> = Contract extends { row_keys: readonly (infer Path extends string)[] }
  ? string extends Path ? DynamicSessionPaths<Result> : SessionPaths<Result, Path>
  : SessionArrayFallback<Result>;

/** Useful session result whose item-bearing rows may reference facts served earlier. */
export type PmReadOutputSessionResult<Result> = Result extends unknown
  ? "row_contract" extends keyof Result
    ? DeclaredSessionPaths<Result, Result["row_contract"]>
    : SessionArrayFallback<Result>
  : never;
