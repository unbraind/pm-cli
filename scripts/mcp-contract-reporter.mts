/** Reject MCP option drift in repository tests while preserving production warnings. */
import type { Vitest } from "vitest/node";
import type { Reporter } from "vitest/reporters";

/** Deliberate negative cases may exercise only these exact warning identities. */
export const MCP_OPTION_WARNING_ALLOWLIST = [{
  file: "tests/unit/mcp/mcp-server-nested-options.spec.ts",
  test: "mcp nested option-key validation (pm-upi0) > flags mutation-shaped options on read tools without rejecting the call",
  warnings: ['dep:pm_deps:deps', 'dep:pm_run:deps'],
  reason: "Proves unknown mutation-shaped options remain advisory and never mutate a read tool.",
}] as const;

/** Fail the suite for every emitted undeclared MCP option outside explicit negative tests. */
export default class McpContractReporter implements Reporter {
  /** Reporter host used to attribute warning records to the emitting test. */
  #vitest!: Vitest;
  /** Unique failures retained even when a test later passes on retry. */
  readonly #violations = new Set<string>();

  /** Capture the runner's test registry before receiving log events. */
  onInit(vitest: Vitest): void {
    this.#vitest = vitest;
  }

  /** Classify every warning in a batched console event without exposing option values. */
  onUserConsoleLog(log: Parameters<NonNullable<Reporter["onUserConsoleLog"]>>[0]): void {
    const entity = log.taskId === undefined ? undefined : this.#vitest.state.getReportedEntityById(log.taskId);
    const file = entity?.module.relativeModuleId.replaceAll("\\", "/") ?? "<unknown>";
    const test = entity?.fullName ?? "<unknown>";
    for (const match of log.content.matchAll(/\[pm-mcp\] Unknown option "([^"]+)" for (\S+) action "([^"]+)"/g)) {
      const identity = `${match[1]}:${match[2]}:${match[3]}`;
      const allowed = MCP_OPTION_WARNING_ALLOWLIST.some((entry) => entry.file === file && entry.test === test && (entry.warnings as readonly string[]).includes(identity));
      if (!allowed) this.#violations.add(`${file} > ${test}: ${identity}`);
    }
  }

  /** Reporter errors make Vitest exit nonzero even when all test assertions passed. */
  onTestRunEnd(): void {
    if (this.#violations.size > 0) throw new Error(`mcp_unknown_option_contract_drift\n${[...this.#violations].sort().join("\n")}`);
  }
}
