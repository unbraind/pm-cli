/**
 * @module sdk/test/command-args
 *
 * Serializes linked-test execution options without loading CLI registration.
 */
/** Append a nonempty string value, trimming the whitespace ignored by CLI option parsers. */
function pushOptionalValueFlag(
  args: string[],
  flag: string,
  value: unknown,
): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  args.push(flag, trimmed);
}

/** Append a boolean switch only when the caller explicitly enabled it. */
function pushOptionalBooleanFlag(
  args: string[],
  flag: string,
  value: unknown,
): void {
  if (value === true) {
    args.push(flag);
  }
}

/** Preserve the order of nonempty repeatable string values while omitting unrelated input types. */
function pushRepeatableValueFlag(
  args: string[],
  flag: string,
  values: unknown,
): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    args.push(flag, trimmed);
  }
}

/** Serialize one item test run with its mutations, selectors, context and explicitly supplied trust flags. */
export function buildBackgroundTestCommandArgs(
  id: string,
  options: Record<string, unknown>,
): string[] {
  const args: string[] = ["test", id, "--run", "--json", "--progress"];
  pushRepeatableValueFlag(args, "--add", options.add);
  pushRepeatableValueFlag(args, "--add-json", options.addJson);
  pushRepeatableValueFlag(args, "--remove", options.remove);
  pushRepeatableValueFlag(args, "--remove-index", Array.isArray(options.removeIndex)
    ? options.removeIndex.map((index) => typeof index === "number" ? String(index) : index)
    : options.removeIndex);
  pushOptionalValueFlag(args, "--match", options.match);
  pushOptionalValueFlag(args, "--only-index", typeof options.onlyIndex === "number" ? String(options.onlyIndex) : options.onlyIndex);
  pushOptionalBooleanFlag(args, "--only-last", options.onlyLast);
  pushRepeatableValueFlag(args, "--measure", options.measure);
  pushOptionalValueFlag(args, "--metric-below", options.metricBelow);
  pushOptionalValueFlag(args, "--metric-diff", options.metricDiff);
  pushSharedBackgroundTestCommandArgs(args, options);
  pushOptionalValueFlag(args, "--author", options.author);
  pushOptionalValueFlag(args, "--message", options.message);
  pushOptionalBooleanFlag(args, "--force", options.force);
  return args;
}

/** Preserve explicit runtime context, assertion policy and trust switches shared by item and tracker runs. */
function pushSharedBackgroundTestCommandArgs(
  args: string[],
  options: Record<string, unknown>,
): void {
  pushOptionalValueFlag(args, "--timeout", options.timeout);
  pushRepeatableValueFlag(args, "--env-set", options.envSet);
  pushRepeatableValueFlag(args, "--env-clear", options.envClear);
  pushOptionalBooleanFlag(args, "--shared-host-safe", options.sharedHostSafe);
  pushOptionalValueFlag(args, "--pm-context", options.pmContext);
  pushOptionalBooleanFlag(
    args,
    "--override-linked-pm-context",
    options.overrideLinkedPmContext,
  );
  pushOptionalValueFlag(args, "--workspace-context", options.workspaceContext);
  pushOptionalBooleanFlag(
    args,
    "--override-linked-workspace-context",
    options.overrideLinkedWorkspaceContext,
  );
  pushOptionalBooleanFlag(
    args,
    "--allow-untrusted-linked-tests",
    options.allowUntrustedLinkedTests,
  );
  pushOptionalBooleanFlag(
    args,
    "--fail-on-context-mismatch",
    options.failOnContextMismatch,
  );
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(
    args,
    "--fail-on-empty-test-run",
    options.failOnEmptyTestRun,
  );
  pushOptionalBooleanFlag(
    args,
    "--require-assertions-for-pm",
    options.requireAssertionsForPm,
  );
  pushOptionalBooleanFlag(args, "--check-context", options.checkContext);
  pushOptionalBooleanFlag(args, "--auto-pm-context", options.autoPmContext);
}

/** Serialize a tracker-wide test run with status filters and shared execution policy. */
export function buildBackgroundTestAllCommandArgs(
  options: Record<string, unknown>,
): string[] {
  const args: string[] = ["test-all", "--json", "--progress"];
  pushOptionalValueFlag(args, "--status", options.status);
  pushOptionalValueFlag(args, "--limit", options.limit);
  pushOptionalValueFlag(args, "--offset", options.offset);
  pushSharedBackgroundTestCommandArgs(args, options);
  return args;
}
