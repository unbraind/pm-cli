/**
 * @module sdk/client-read-operations
 *
 * Defines short-lived client operations for reads, execution, and diagnostics.
 */
import type { AggregateOptions, AggregateResult } from "../cli/commands/aggregate.js";
import type { ContextOptions, ContextResult } from "../cli/commands/context.js";
import type { GetOptions, GetResult } from "../cli/commands/get.js";
import type { ListOptions, ListResult } from "../cli/commands/list.js";
import type { NextOptions, NextResult } from "../cli/commands/next.js";
import type { SearchOptions, SearchResult } from "../cli/commands/search.js";
import type { StatsCommandOptions, StatsResult } from "./diagnostics/stats.js";
import type {
  TelemetryCommandOptions,
  TelemetryResult,
} from "./diagnostics/telemetry.js";
import type { EvalOptions, EvalResult } from "./eval.js";
import { PmClient, type PmClientOptions } from "./runtime.js";
import type { TestAllCommandOptions, TestAllResult } from "./test/batch.js";
import type { TestCommandOptions, TestResult } from "./test/execution.js";

/** Return the same context snapshot produced by `pm context` without constructing a reusable client. */
export function context(
  options: ContextOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ContextResult> {
  return new PmClient(clientOptions).context(options);
}

/** List items with the MCP/agent compact defaults without constructing a reusable client. */
export function list(
  options: ListOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ListResult> {
  return new PmClient(clientOptions).list(options);
}

/** Search items with the MCP/agent compact defaults without constructing a reusable client. */
export function search(
  query: string,
  options: SearchOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<SearchResult> {
  return new PmClient(clientOptions).search(query, options);
}

/** Read one item by id without constructing a reusable client. */
export function get(
  id: string,
  options: GetOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<GetResult> {
  return new PmClient(clientOptions).get(id, options);
}

/** Return the ranked next-work recommendation produced by `pm next` without constructing a reusable client. */
export function next(
  options: NextOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<NextResult> {
  return new PmClient(clientOptions).next(options);
}

/** Group matching items with the same semantics as `pm aggregate` without constructing a reusable client. */
export function aggregate(
  options: AggregateOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<AggregateResult> {
  return new PmClient(clientOptions).aggregate(options);
}

/** Return project tracker statistics with the same sections as `pm stats` without constructing a reusable client. */
export function stats(
  options: StatsCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<StatsResult> {
  return new PmClient(clientOptions).stats(options);
}

/** Add, inspect, or execute one item's linked tests without constructing a reusable client. */
export function test(
  id: string,
  options: TestCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<TestResult> {
  return new PmClient(clientOptions).test(id, options);
}

/** Execute linked tests across tracker items without constructing a reusable client. */
export function testAll(
  options: TestAllCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<TestAllResult> {
  return new PmClient(clientOptions).testAll(options);
}

/** Inspect or manage telemetry diagnostics without constructing a reusable client. */
export function telemetry(
  options: TelemetryCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<TelemetryResult> {
  return new PmClient(clientOptions).telemetry(options);
}

/** Evaluate canonical search rankings without constructing a reusable client. */
export function evaluate(
  options: EvalOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<EvalResult> {
  return new PmClient(clientOptions).evaluate(options);
}
