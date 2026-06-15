import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import type { LinkedTest } from "../../types.js";

/**
 * Pure selection logic for `pm test --run` selectors (pm-p86h / GitHub #194).
 *
 * Selectors pick WHICH linked tests execute without mutating item metadata:
 * - `--match <substring>`: case-insensitive substring on command/path.
 * - `--only-index <n>`: 1-based index into the `--list` order.
 * - `--only-last`: most recently added entry (last in `--list` order).
 */

export type LinkedTestSelectorKind = "match" | "only-index" | "only-last";

export interface LinkedTestRunSelector {
  match?: string;
  onlyIndex?: number;
  onlyLast?: boolean;
}

export interface LinkedTestRunSelection {
  selector: LinkedTestSelectorKind | null;
  requested: string | null;
  selected: LinkedTest[];
  /** 1-based positions of selected entries in the original `--list` order. */
  selected_indexes: number[];
  selected_count: number;
  skipped_count: number;
}

const MAX_SELECTOR_ENTRY_LABEL_LENGTH = 100;

export function parseOnlyIndexValue(raw: string | number, optionName = "--only-index"): number {
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new PmCliError(
      `${optionName} requires a 1-based integer index into the linked-test list (got "${raw}"). Use pm test <id> --list to inspect positions.`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

function summarizeSelectorEntry(entry: LinkedTest): string {
  const label = entry.command ?? entry.path ?? "<no command>";
  const normalized = label.replaceAll(/\s+/g, " ").trim() || "<no command>";
  if (normalized.length <= MAX_SELECTOR_ENTRY_LABEL_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SELECTOR_ENTRY_LABEL_LENGTH - 3)}...`;
}

export function describeLinkedTestEntries(tests: LinkedTest[]): string {
  return tests.map((entry, index) => `${index + 1}. ${summarizeSelectorEntry(entry)}`).join("; ");
}

function activeSelectorKinds(selector: LinkedTestRunSelector): LinkedTestSelectorKind[] {
  const kinds: LinkedTestSelectorKind[] = [];
  if (selector.match !== undefined) {
    kinds.push("match");
  }
  if (selector.onlyIndex !== undefined) {
    kinds.push("only-index");
  }
  if (selector.onlyLast === true) {
    kinds.push("only-last");
  }
  return kinds;
}

function entryMatchesSubstring(entry: LinkedTest, needle: string): boolean {
  const command = entry.command?.toLowerCase() ?? "";
  const entryPath = entry.path?.toLowerCase() ?? "";
  return command.includes(needle) || entryPath.includes(needle);
}

export function resolveLinkedTestRunSelection(tests: LinkedTest[], selector: LinkedTestRunSelector): LinkedTestRunSelection {
  const kinds = activeSelectorKinds(selector);
  if (kinds.length === 0) {
    return {
      selector: null,
      requested: null,
      selected: tests,
      selected_indexes: tests.map((_, index) => index + 1),
      selected_count: tests.length,
      skipped_count: 0,
    };
  }
  if (kinds.length > 1) {
    throw new PmCliError(
      `Combine at most one linked-test selector per run: ${kinds.map((kind) => `--${kind}`).join(" and ")} were provided. Pick one of --match, --only-index, --only-last.`,
      EXIT_CODE.USAGE,
    );
  }
  const kind = kinds[0];
  if (tests.length === 0) {
    throw new PmCliError(
      `--${kind} matched no linked tests because this item has none. Add one first with --add, --command, or --add-json.`,
      EXIT_CODE.USAGE,
    );
  }
  if (kind === "match") {
    // kind is "match" only when selector.match is defined (see activeSelectorKinds).
    const needle = (selector.match as string).trim().toLowerCase();
    if (needle.length === 0) {
      throw new PmCliError("--match requires a non-empty substring to match against linked-test command/path values", EXIT_CODE.USAGE);
    }
    const selectedIndexes: number[] = [];
    const selected: LinkedTest[] = [];
    for (let index = 0; index < tests.length; index += 1) {
      if (entryMatchesSubstring(tests[index], needle)) {
        selected.push(tests[index]);
        selectedIndexes.push(index + 1);
      }
    }
    if (selected.length === 0) {
      throw new PmCliError(
        `--match "${selector.match}" matched none of the ${tests.length} linked test(s). Available entries: ${describeLinkedTestEntries(tests)}`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      selector: "match",
      requested: selector.match as string,
      selected,
      selected_indexes: selectedIndexes,
      selected_count: selected.length,
      skipped_count: tests.length - selected.length,
    };
  }
  if (kind === "only-index") {
    const index = parseOnlyIndexValue(selector.onlyIndex as number);
    if (index > tests.length) {
      throw new PmCliError(
        `--only-index ${index} is out of range: this item has ${tests.length} linked test(s). Available entries: ${describeLinkedTestEntries(tests)}`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      selector: "only-index",
      requested: String(index),
      selected: [tests[index - 1]],
      selected_indexes: [index],
      selected_count: 1,
      skipped_count: tests.length - 1,
    };
  }
  return {
    selector: "only-last",
    requested: "last",
    selected: [tests[tests.length - 1]],
    selected_indexes: [tests.length],
    selected_count: 1,
    skipped_count: tests.length - 1,
  };
}
