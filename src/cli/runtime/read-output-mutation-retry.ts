/**
 * @module cli/runtime/read-output-mutation-retry
 *
 * Turns a `read_output_mutation_conflict` refusal (pm-rrwh2o), a hybrid
 * read-and-mutate command given universal output controls, into the caller's
 * own invocation without those controls. Dropping each control token and the
 * value it consumed is the whole repair: tracker scope, operands, the
 * mutation flags and every other token stay where they were.
 */
import type { PmCliErrorRecoveryPayload } from "../../sdk/runtime-primitives.js";
import { findBootstrapCommandTokenIndex } from "../../sdk/cli-bootstrap.js";
import {
  hasSubcommandFlagContractsForCommand,
  resolveSubcommandFlagContractsForCommand,
} from "../../sdk/cli-contracts/flag-contracts.js";
import { enrichCliFlagInvocationContracts } from "../../sdk/flag-invocation-contracts.js";
import {
  READ_OUTPUT_MUTATION_CONFLICT_CODE,
  READ_OUTPUT_SHAPING_CONTROL_FLAGS,
} from "../../sdk/read-output-contracts.js";
import { renderPmCommand } from "../argv-utils.js";
import { scanOptionTokens, type ScannedOptionToken } from "./projection-retry.js";

const SHAPING_CONTROL_FLAGS: ReadonlySet<string> = new Set(READ_OUTPUT_SHAPING_CONTROL_FLAGS);

/** A URL authority carrying userinfo (`scheme://user:secret@host`), as in a credentialed package source. */
const URL_USERINFO = /\/\/[^/?#\s]*@/u;

/** More candidate URL starts than this in one token are judged conservatively instead of parsed. */
const MAX_URL_CANDIDATES = 8;

/** Characters a URL scheme may contain after its first letter. */
const SCHEME_CHARACTERS = /^[A-Za-z0-9+.-]$/u;

/**
 * Every position where a URL scheme could start in a token, in one linear
 * pass: for each `:`, the run of scheme characters before it, and each
 * letter in that run that follows its start or a `+`, `.` or `-`, so an inline
 * option value (`--add=https:...`) and a wrapper chain (`npm:git+https:...`)
 * both yield the inner scheme. Undefined when there are more than
 * {@link MAX_URL_CANDIDATES}.
 */
function urlCandidateStarts(token: string): number[] | undefined {
  const starts: number[] = [];
  for (let colon = token.indexOf(":"); colon !== -1; colon = token.indexOf(":", colon + 1)) {
    let runStart = colon;
    while (runStart > 0 && SCHEME_CHARACTERS.test(token[runStart - 1]!)) runStart -= 1;
    for (let position = runStart; position < colon; position += 1) {
      const startsScheme = /^[A-Za-z]$/u.test(token[position]!) && (position === runStart || "+.-".includes(token[position - 1]!));
      if (!startsScheme) continue;
      starts.push(position);
      if (starts.length > MAX_URL_CANDIDATES) return undefined;
    }
  }
  return starts;
}

/**
 * Whether a token carries URL credentials in any spelling the URL parser
 * accepts: backslash-normalized authorities (`https:\\user:secret@host`),
 * wrapper chains (`npm:git+https:...`) and inline option values
 * (`--add=https:user:secret@host`), which the literal `//` pattern misses.
 * A token with too many candidate schemes that contains an `@` counts as
 * credentialed.
 */
function carriesUrlCredentials(token: string): boolean {
  // Userinfo always ends at an @, so text without one needs no parsing at all.
  if (!token.includes("@")) return false;
  if (URL_USERINFO.test(token)) return true;
  const starts = urlCandidateStarts(token);
  if (starts === undefined) return true;
  return starts.some((start) => {
    const candidate = token.slice(start);
    if (!URL.canParse(candidate)) return false;
    const url = new URL(candidate);
    return url.username !== "" || url.password !== "";
  });
}

/**
 * The command path whose flags the argv carries: the namespaced two-token
 * path (`item comments`, the form the error path records) when one declares
 * flags, else the command token itself.
 */
function invocationCommandPath(argv: readonly string[]): string | undefined {
  const index = findBootstrapCommandTokenIndex([...argv]);
  if (index === undefined) return undefined;
  const leaf = argv[index + 1];
  const namespaced = leaf === undefined || leaf.startsWith("-") ? undefined : `${argv[index]} ${leaf}`;
  return namespaced !== undefined && hasSubcommandFlagContractsForCommand(namespaced) ? namespaced : argv[index];
}

/**
 * Every spelling of a flag the command path's invocation contract declares as
 * value-taking. The flag-invocation parity gate verifies these arities
 * against the parser, unlike the vocabulary rows, which leave command flags
 * such as `--message` untyped.
 */
function valueTakingFlags(commandPath: string | undefined): ReadonlySet<string> {
  const contracts = enrichCliFlagInvocationContracts(commandPath ?? "", resolveSubcommandFlagContractsForCommand(commandPath));
  return new Set(contracts.filter((contract) => contract.takes_value).flatMap((contract) => [contract.flag, ...(contract.aliases ?? [])]));
}

/**
 * Rewrite the refusal's retry as the caller's argv without its universal
 * output controls. The retry writes, so `scopePrefix` binds a tracker the
 * invocation did not spell itself (an environment selection) and null
 * withdraws the retry, as for the other mutation retries. When the argv
 * cannot be scanned unambiguously or names no control, the retry is withheld
 * and the refusal's guidance still names the controls to drop. It is also
 * withheld when the parse around a control is ambiguous: a control that took
 * a flag-like token as its value swallowed another option, and a control
 * right after a value-taking option may be that option's value. A retry
 * rebuilt from such an argv would replay the misparse as a clean write.
 * `revisionGuarded` reports an enclosing SDK revision scope (an embedded CLI
 * run): its guards never reached argv, so a retry run on its own would write
 * unguarded and is withheld too. An argv carrying URL credentials (a package
 * source such as `https://user:token@host/pkg.tgz`) gets no executable retry
 * either, so the recovery never repeats the secret in one more field.
 */
export function repairReadOutputMutationRecovery(
  argv: readonly string[],
  code: string | undefined,
  recovery: PmCliErrorRecoveryPayload | undefined,
  scopePrefix: readonly string[] | null = [],
  revisionGuarded: () => boolean = () => false,
): PmCliErrorRecoveryPayload | undefined {
  if (code !== READ_OUTPUT_MUTATION_CONFLICT_CODE) return recovery;
  const withheld = recovery === undefined ? undefined : { ...recovery, suggested_retry: undefined, suggested_retry_args: undefined };
  const commandPath = invocationCommandPath(argv);
  const options = scanOptionTokens(argv, commandPath);
  if (options === undefined || scopePrefix === null || argv.some(carriesUrlCredentials) || revisionGuarded()) return withheld;
  const removed = controlTokenIndexes(argv, options, valueTakingFlags(commandPath));
  if (removed === undefined || removed.size === 0) return withheld;
  const retry = [...scopePrefix, ...argv.filter((_, index) => !removed.has(index))];
  return { ...recovery, suggested_retry: renderPmCommand(retry), suggested_retry_args: retry };
}

/**
 * Indexes of every control token and the value it consumed, or undefined when
 * the parse around a control is ambiguous: the control took a flag-like token
 * as its value, it follows a value-taking option that may own it, or a control
 * spelling would be left in the retry.
 */
function controlTokenIndexes(
  argv: readonly string[],
  options: ReadonlyMap<number, ScannedOptionToken>,
  valueFlags: ReadonlySet<string>,
): Set<number> | undefined {
  const removed = new Set<number>();
  for (const [index, { flag, consumesValue }] of options) {
    if (!SHAPING_CONTROL_FLAGS.has(flag)) continue;
    const previous = argv[index - 1];
    if (previous !== undefined && !previous.includes("=") && valueFlags.has(previous)) return undefined;
    if (consumesValue && argv[index + 1]?.startsWith("-") === true) return undefined;
    removed.add(index);
    if (consumesValue) removed.add(index + 1);
  }
  // A control the scanner took as another option's value (`--limit --output-session ...`) would stay in
  // the retry and reproduce the conflict, so any control spelling left over withholds the retry.
  const leftover = argv.some((token, index) => !removed.has(index) && SHAPING_CONTROL_FLAGS.has(token.split("=", 1)[0]!));
  return leftover ? undefined : removed;
}
