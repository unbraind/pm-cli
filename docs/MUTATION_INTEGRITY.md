# Mutation Integrity

Tracker references: [pm-h90s](../.agents/pm/issues/pm-h90s.toon), [pm-pim7](../.agents/pm/features/pm-pim7.toon), [pm-w8q4](../.agents/pm/features/pm-w8q4.toon), [pm-9yfo](../.agents/pm/tasks/pm-9yfo.toon), [pm-wwooxx](../.agents/pm/issues/pm-wwooxx.toon), [pm-3kk6](../.agents/pm/issues/pm-3kk6.toon)

Concrete home-path normalization is tracked by [pm-gh1583](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1583.toon). Tracker records are repository-only and excluded from npm.

`pm` treats mutation provenance and content safety as shared SDK policy. CLI,
MCP, and package hosts can therefore enforce the same rules without duplicating
argument parsing or exposing detected values.

## Agent Quick Context

- Every mutation should have a stable author. Precedence remains explicit
  invocation author, `PM_AUTHOR`, configured `author_default`, detected
  harness identity, then `unknown`.
- The secret guard inspects string leaves and the property names that label
  them, and returns only detector names and object paths, never the matched
  text of a leaf. A flagged property name appears in a path only as a
  positional placeholder (`[key <n>]`). Unflagged property names appear in
  paths as written, so a name that merely equals a credential held elsewhere
  in the payload is not redacted.
- `pm health` reports old, unclaimed in-progress work as advisory governance
  data. It does not change ownership or status.
- Historical unknown-author events remain immutable. Maintainers can append an
  audited acknowledgment rather than rewriting their original JSONL streams.

## Workspace Policy

Configure policy through `pm config`; do not hand-edit `settings.json`.

```bash
pm config project set mutation_guard_require_attributed_author true
pm config project set mutation_guard_secret_guard block
pm config project set mutation_guard_stale_in_progress_hours 48
```

Defaults preserve author compatibility while providing secret advice:

| Setting                                    | Default  | Behavior                                                 |
| ------------------------------------------ | -------- | -------------------------------------------------------- |
| `mutation_guard.require_attributed_author` | `false`  | When enabled, reject an effective author of `unknown`.   |
| `mutation_guard.secret_guard`              | `advise` | `off`, stderr/structured `advise`, or pre-write `block`. |
| `mutation_guard.stale_in_progress_hours`   | `72`     | Inactivity threshold for stale work: `pm health` advisories, `pm context` idle counts, and `pm claim --takeover-stale`. |

One activity clock serves every stale-work consumer: the newer of an item's
`updated_at` and its latest substantive history entry. Ordinary mutations
advance both; `pm restore` writes the historical document, with its older
`updated_at`, and appends a new entry, so the stream counts too. Maintenance
entries (`history-compact`, `history-repair`, `history-redact`) preserve the
record without working on the item and do not count. A compaction baseline
stands for its pruned prefix and records that prefix's newest substantive
time as `context.history_compaction.last_activity_at`, so repeated
compaction never renews an abandoned claim. A baseline written before that
field existed carries only its own timestamp, the last pruned entry's time,
which does not bound the pruned work because history keeps caller-supplied
timestamps without an ordering check. Advisory reads approximate its activity
with that timestamp.

A takeover trusts no summary or rewrite. It anchors on the holder's own claim
record: the newest original entry that set the current assignee, or a claim
that moved only `claim_principal` (another session of the same principal took
the item). Records
before it cannot be the holder's work, so a compacted, salvaged or legacy
prefix never matters. The takeover refuses (`claim_activity.unproven_activity`)
in these cases:

| Reason | Cause |
| --- | --- |
| `claim_record_unavailable` | No original record sets the holder: the history is silent, missing, or folded the claim into a compaction baseline. |
| `discarded_history_tail` | A `history-repair --salvage-tail` after the claim discarded a record whose time is unknown. |
| `rewritten_history` | A `history-repair`, `history-redact` or merge reconcile after the claim rewrote records, or `reanchor_evidence` on the claim or a later record shows a changed patch (a merge rebase leaves no audit entry). |
| `workspace_restored` | A workspace snapshot restore at or after the claim may have replaced the holder's later work. Also when a salvage, repair, redaction or merge reconcile of the workspace stream is dated at or after the claim, when a compacted workspace stream's baseline cannot bound its pruned records before the claim, or when the workspace stream cannot be read to rule a restore out. |

The holder can release such an item; a new claim starts a provable record.
Restore precedence uses wall-clock time and assumes the restoring host's clock
does not run behind the holder's. Ordering restores by a durable generation
instead is tracked as pm-8su89a. A restore that activates while a takeover is
between its reads and its commit is not yet fenced; that gap affects every
item writer and is tracked as pm-vgk0nj. Rewrite detection also trusts the
history merge driver to keep provenance: its dedup identity omits `context`,
`event_class` and `reanchor_evidence`, so two records that match on everything
else collapse into one. That is tracked as pm-0574of. A
stream any of whose records lacks a parseable timestamp, or holds a baseline
with a malformed receipt, is unreadable for a takeover, and `history-compact`
refuses to prune such a record (it would launder the damage into a judgeable
stream). A takeover refuses when
the stream exists but cannot be read (`claim_activity.history_unreadable`),
because recent work may hide behind it. A threshold too large for the Date range reports
`eligible_at: null` rather than failing. `pm health` reports three advisories
in the storage check, none of which fails the verdict:

| Warning                       | Population                                               | Remedy printed by `pm health`                                            |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `in_progress_unowned:<n>`     | in-progress items with no assignee (so no live claim)    | `pm list --status <in_progress> --assignee-filter unassigned`            |
| `in_progress_idle:<n>`        | in-progress items idle past the threshold, owned or not  | `pm list --status <in_progress> --updated-before -<hours>h`              |
| `stale_in_progress_items:<n>` | both: unowned and idle                                   | `pm list --status <in_progress> --assignee-filter unassigned --updated-before -<hours>h` |

The storage check's `details.in_progress_work` lists up to 25 ids per group
with each group's sweep, plus the per-item recoveries `pm claim <id>` (unowned
work), `pm claim <id> --takeover-stale` (another holder's idle claim) and
`pm update <id> --status <open>`. Sweeps and recoveries carry `--pm-path` when
the diagnosed tracker was selected explicitly or through `PM_PATH`. A sweep is a candidate list by metadata
time: it can include an item whose history is newer than its `updated_at`
(for example after a restore), which the advisory does not count;
`pm claim <id> --takeover-stale` re-judges each one under the item lock. `pm context` reports `in_progress_unowned`
and `in_progress_idle` next to `in_progress` in its summary when they are
non-zero, so unattended work is not read as active work. `in_progress` counts
the same population as both advisories: every item in the configured progress
status, whatever role that status carries (GH-1756).

A blocking secret policy may be bypassed only by an explicit `--force` on a
force-capable mutation. The warning records that an override occurred while
remaining fully redacted.

## SDK Use

Package hosts can apply the exact runtime policy before dispatch:

```ts
import {
  evaluateMutationGuard,
  inspectInProgressWork,
  inspectStaleInProgressItems,
  resolveRuntimeStatusRegistry,
  scanMutationSecrets,
} from "@unbrained/pm-cli/sdk";

const guarded = evaluateMutationGuard({
  author: "package-agent",
  payload: mutationInput,
  settings: projectSettings.mutation_guard,
});

const findings = scanMutationSecrets(mutationInput);
const stale = inspectStaleInProgressItems(items, {
  in_progress_status:
    projectSettings.schema.workflow.in_progress_status ?? "in_progress",
  threshold_hours: projectSettings.mutation_guard.stale_in_progress_hours,
});
// Unowned, idle and stale groups from one pass; scanInProgressWork(pmRoot, ...)
// also reads history, but only for items whose metadata already looks idle.
// The registry resolves stored status aliases, as the in-progress counters do.
const work = inspectInProgressWork(items, {
  status_registry: resolveRuntimeStatusRegistry(projectSettings.schema),
  threshold_hours: projectSettings.mutation_guard.stale_in_progress_hours,
});
```

`resolveItemOwnershipActivity(pmRoot, id, holder, { updated_at, threshold_hours })`
returns the same claim evidence a refused `pm claim` reports, and
`buildInProgressSweepCommands(status, hours)` returns the exact list sweeps
`pm health` prints.

`evaluateMutationGuard` returns stable warning codes, redacted findings, and
whether a blocking policy was explicitly overridden. `scanMutationSecrets` is
available separately for package-specific preflight UIs. Cyclic inputs are
safe; scanner failures fail open with `secret_guard_scan_failed_open`.

### Deciding findings by category

`SecretGuardFinding["rule"]` (exported as `SecretGuardRule`) gains a member
whenever a detector is added, so an exhaustive
`Record<SecretGuardRule, Decision>` breaks compilation on a routine upgrade
([pm-gh1749](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1749.toon);
tracker record excluded from npm). Decide findings with a policy instead:

```ts
import {
  decideSecretGuardFinding,
  scanMutationSecrets,
  type SecretGuardPolicy,
} from "@unbrained/pm-cli/sdk";

const policy: SecretGuardPolicy<boolean> = {
  default: true, // refuse
  categories: { network: false, path: false },
  rules: { private_ssh_target: true },
};
// A finding whose inspection did not complete needs review, whatever the
// policy says about its category.
const refused = scanMutationSecrets(mutationInput).some(
  (finding) =>
    finding.normalization_incomplete === true ||
    decideSecretGuardFinding(policy, finding),
);
```

Every detector belongs to one stable category: `credential` (tokens, keys,
password, high-entropy and credential-key assignments), `network` (private
IPv4 addresses, private SSH targets and user-at-private-host addresses) or
`path` (absolute home-directory paths). The most specific entry wins: a `rules`
entry, then the finding's `categories` entry, then `default`. A detector added
later joins an existing category and takes that category's decision, or the
default when the policy names no such category, without a policy change, unless the
policy already holds a defined own `rules` entry for it, which still wins. A rule the running SDK does not know, such as
one in a finding decoded from a newer host, has no category: an exact `rules`
entry for it still applies, and otherwise it takes the default. Entries whose
value is `undefined` count as absent; a `rules` entry may name a rule this SDK
does not ship yet, and other keys that name no rule or category are ignored.
Only the policy's own `default`, `categories` and `rules` are read, never
inherited ones. The default must be defined (`null` is a valid decision). The
helper returns `D` without `undefined` for a policy typed as
`SecretGuardPolicy<D>`, including inside a generic wrapper. For any other
policy shape it infers the policy's own type and returns every decision that
type can hold (`SecretGuardPolicyDecision<typeof policy>`): the union of the
named decisions for an inline policy or one declared with `satisfies`, even
when they mix kinds such as `true | "allow"` or a string default with `null`
overrides. A union of policy types yields every member's decisions, and a
`categories` key that names no category adds none. A wrapper generic over the
policy type itself calls `decideSecretGuardFinding<P>(policy, finding)` to
return `SecretGuardPolicyDecision<P>`, and a `rules` map typed by a named
interface passes to the helper as it is. A map typed only as `object` hides
its keys, so it widens the result to `unknown`. The types cannot see entries
that TypeScript's own assignability rules let through, such as a
`Record<string, unknown>` from a configuration loader or a value typed `{}`
assigned to a typed policy, so validate untyped input before annotating it as
`SecretGuardPolicy<D>`, or type it as `SecretGuardPolicy<unknown>`; a
policy that is not an object, has no own `default` or has `default:
undefined`, holds `categories` or `rules` that are not plain objects (their
prototype must be `Object.prototype`, of any realm, or `null`: an array,
`Map`, `URLSearchParams`, class instance or a map that inherits entries keeps
them where an own-property lookup never finds them), or a finding without a
string `rule`, throws a `TypeError`.

`SECRET_GUARD_RULE_CATEGORIES` maps every shipped rule to its category and
`secretGuardRuleCategory(rule)` returns `undefined` for an unknown one.
`Record<SecretGuardRuleCategory, Decision>` is the stable exhaustive key: a new
category is released as a declared SDK contract change, and so is every new
rule, so the release notes list the new literal under Changed (SDK contract).

Direct SDK persistence does not automatically apply this host preflight.
Integrations that require the policy must evaluate it before dispatching their
SDK mutations. CLI and MCP adapters already do this.

The SDK guard and repository scanner consume one inventory in
`src/core/shared/secret-rules.ts`. It covers GitHub, npm, Slack, AWS access
keys (including temporary keys), Google, Anthropic, OpenAI, GitLab, Sentry,
private keys, JWT-shaped tokens, npm authentication assignments, password
assignments, inline sshpass passwords, private IPv4 addresses, private SSH
hosts, and absolute home-directory paths. Every repository rule also runs
against mutation string leaves in `advise` and `block` modes.

Two repository fixture exemptions apply only to `tests/` and `examples/`:
absolute home paths and user-at-private-host matches. They never exempt
mutation content. The inventory explicitly records two mutation-only
heuristics: high-entropy assignments and credential-key assignments. Source
identifiers and test fixtures can resemble generic assignments, so neither runs
over repository source text.

Credential-key assignments
([pm-gh1704](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1704.toon);
tracker record excluded from npm) flag a value under any key whose last word
names a credential: `secret`, `token`, `api_key`, `secret_key`, `private_key`,
`access_key`, `client_secret`, `passwd` and `pwd`, plus compound keys such as
`DB_PASSWORD`, `aws_secret_access_key` or `GITHUB_TOKEN`, in any case,
including `--token=…`. The value must be at least eight whitespace-free
characters (a quoted value must be whitespace-free up to its closing quote)
with a Shannon entropy of at least 3 bits per character. It must not be a
placeholder (`<…>`, `${…}`, `$(…)`, `$VAR`, `%VAR%`, `[scrubbed]`), a
filesystem path or SSH key-file name, a URL, a letters-only or hyphenated
word, a CONSTANT_CASE name ending a statement (`= DEFAULT_TOKEN;`), a dotted
member path or a call
(a quoted value or an element body counts whole up to its closing quote;
directly after `=`, `?`, `:` and `|` also count; elsewhere unquoted they read
as code such as `options?.token`); a
whole
element body must satisfy the same grammar. `token_budget`, `max_tokens`, numeric
counts, masks such as `********` and prose stay clean. A key starts only at the
beginning of an identifier, so the scan stays linear. Plain and hyphenated
password keys remain with the password rule, so each value is reported once.

A credential-key value that holds a run-time reference is judged by the
literal it spells
([pm-hw00c2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hw00c2.toon);
tracker record excluded from npm). A value that holds `${…}`, `$(…)`,
`$NAME` or `<…>` is captured whole. So is a value that opens with a quoted
piece concatenated as a shell concatenates `"${EMPTY}"…`: a reference or
another quoted piece follows it, or it holds a reference and a letter, digit
or non-operator symbol (`_ @ # ~`, or a `!` that no operator follows)
follows. A quoted value followed by an operator (`"…".trim()`,
`"${KEY}".toUpperCase()`, `"Bearer"+x`) stays a quoted value, and in unquoted
source a value is code when a binary operator (including `^` and `&`) or member access
follows its leading references (`${X}.trim`, `$TOKEN.length+1`, `$($(cmd)).length`,
`$TOKEN+suffix`) or a call's parenthesis follows it (`<string>getToken()`,
`<string>getToken ()`), and a value led by an angle span is code when the
span holds a TypeScript type (`<string>`, `<T>`, `<APIKey>`, `<auth.Token>`,
`<string|undefined>`, `<T[]>`, `<{value:string}>`, a literal type such as
`<"bearer">`; a
lowercase word such as `<x>` and an ALL-CAPS
name such as `<TOKEN>` are placeholders) or expression code
follows it (`{ token: <t>name ?? fallback }`); a letter,
digit, quoted piece or other punctuation (`!`, `@`, `#`) after a reference is
still a literal concatenation. After `=`, a value led
by an angle span is a TypeScript type assertion or a shell redirection
(`const token = <string>auth_token || fallback`), never a placeholder; after
`:` (YAML, prose) `<x>…` is still judged. The constant
statement exclusion judges the literal (`<string>DEFAULT_TOKEN;`); in a quoted
value or payload data it is still judged. The literal
left once its references expand is then judged by the same grammar, length,
entropy and exclusions as a reference-free value, read in the value's own
quote context. So `api_key=${EMPTY}"…"`, `api_key=$VAR"…"`, `token: <x>…`,
`"client_secret": "${EMPTY}…"` and the literal default `${KEY:-…}` are
reported, while a bare `${API_KEY}`, `$(op read key)`, `<placeholder>`, an
empty default, and a literal that is a path, URL or word stay clean. At most
64 literal characters may come before the first reference; a longer prefix is
judged as a reference-free value. References and quoted pieces are
whitespace-free, as every credential-key value is, and the shell control
operators `|`, `||` and `&&` end one (`$(get_key)||fallback` spells nothing;
a single `&` is data, as in YAML), as do
`?` and `:`, which after a reference are code (`$TOKEN?.x`, `$TOKEN??y`), so a
spaced command substitution is never read as one value, and a key inside it keeps its own
verdict. The rule also scans its unchanged reference-free grammar as a
baseline reading, judged on the captured text exactly as before, and a value
is reported when either reading reports it. So
the referenced reading only adds findings, and every key the reference-free
scan visits, including one inside a rejected referenced value, keeps its
verdict. A key inside a rejected referenced value is also judged once by the
referenced reading, and the scan then resumes after it, so each character is
read at most twice. That rescan reaches one level, so a referenced credential
two references deep is judged only as the reference-free grammar judges it.

One `$NAME` policy holds for every key-named rule. A `$NAME` reference
expands to nothing when NAME is CONSTANT_CASE, the environment-variable
convention (`$DB_PASSWORD`, `$API_KEY`), and no literal text comes before it
in its word (`$VAR"…"`, `${EMPTY}$VAR…`), or when it is the whole value, in
quotes or not (a bare `$password`). Either way the value grammar must have
read the whole word. An unquoted value did when whitespace or the end of the
text follows it, optionally after structure such as `;` or `)`, or, for a key
found inside a rejected reference value, at the closer of the reference that
encloses it, whatever follows, or, inside a command substitution and outside
its quoted text, at a shell control operator or redirection (`|`, `&`, `;`,
`<`, `>`), where its judged value also ends. In a braced reference's word or
quoted text those characters are data, and any other parenthesis or brace is
literal data. A quoted value under a quoted key did as well when structure
and then the next member or element follows, as in compact JSON (`{"password":"$DB_PASSWORD","other":…}`,
`[{"password":"$DB_PASSWORD"},{"other":…}]`). An unquoted value did too when
the quote after it closes the string the value sits in and a word end follows
that quote: whitespace, the end of the text, or structure, optional blanks
and then a line break, the end of the text, or the next member or element
(`{"cmd":"password=$DB_PASSWORD"}`, `["password=$DB_PASSWORD"], "next"`,
`Use "password: $DB_PASSWORD" in config`). Any other text after it (`$PW:…`,
`$PW[…`, `$PW,"…"`, `"$PW""…"`) belongs to the same word, and so does any
other quote after an unquoted value, which may open a concatenated piece
(`$PW""…`, `$PW" spaced literal"`), or a quote no string opened (a YAML plain
scalar ending in `"`). In those cases the value keeps its `$NAME` text
literal.

A value that sits in a string ends at that string's closing quote
([pm-gh1775](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1775.toon);
tracker record excluded from npm). A payload string such as
`{"title":"api_key: ${API_KEY}","updated":"…"}` holds an assignment inside the
title string. The two key-named rules find the string a value sits in with
one linear lexical pass over the text: a quote opens a string of its kind
when none is open and closes the open string of its kind, a quote of the
other kind inside a string is data, a quote right after a letter, digit or
underscore never opens one (a prose apostrophe such as `customer's`, or a
unit mark), a backslash escapes the next character, and a line feed or
carriage return ends every string (U+2028 and U+2029 are data inside a JSON
string). When that string's closing quote lies inside the captured value,
after its first character, or directly after it, and a word end as above
follows the quote, the value ends there. After a closing quote, an unquoted
YAML flow key (`{title: "…", updated: ok}`) is a word end too, and so is the
end of an XML tag (`"/>`, `">`) when the string is an attribute value (its
quote follows `=` and optional blanks), and blanks after its structure are padding however
many there are. A quote at the value's first character is never a cut point,
because after a stray apostrophe it may be the value's own opening quote, and
neither is a quote inside the capture that a blank follows, which can only be
data of the value's own quoted text (`"devs' portal"`, `${PW:-" … "}`). So `","` and the next member are
never read as quoted pieces concatenated to the value, however long the next
member is, and the scan resumes at the closing quote, so keys in the later
members are still scanned. The bare reference is then judged as a whole value
and stays clean under every credential key, while a literal attached to it
inside the string (`${EMPTY}…`, `${KEY:-…}`) and a credential member next to it
are still reported. A value that sits in no string keeps its own quoted
pieces (`password="$PW","…"`, a YAML single-quoted scalar whose doubled
quotes are data), and a closing quote that another quote or a word follows
(`echo "api_key=${EMPTY}""…"`) continues the shell word, as before.

A whole Windows variable (`%DB_PASSWORD%`) is a placeholder for every
key-named rule. `cmd.exe` reads `set NAME=value` to the end of the line, so an
unquoted text value is whole only when nothing but blanks follows it on its
line or when it ends at the string it sits in; a decoded literal and an
element body are whole by construction, and a quoted value is whole when
structure (`,` `;` `)` `}` `]`) or the end of its line follows its closing
quote, because a `set` line goes on after it. So a dotenv or
`set` line whose percent reference more words follow, and a literal attached
to the reference (`%API_KEY%…`, under any credential key), are still reported.

A credential-key value led by a lowercase `$name` keeps the reference-free
reading, in which a `$`-led literal is a placeholder. Any other `$` text is literal, so a
credential that merely contains `$`, after other characters or escaped as
`\$`, keeps its characters. No rule is silently
gate-only. Repository diagnostics retain hyphenated names; SDK findings retain
underscore names. Adding a pattern therefore changes both consumers together.

Assignment rules also recognize structured spellings
([pm-gh1699](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1699.toon);
tracker record excluded from npm). Each rule declares its structured key
vocabulary as data, so quoting the key never changes the verdict. These
spellings are covered:

- a quoted key followed by `:` or `=` (JSON, YAML flow, Python dict, TOML);
- every quoted string in value position inside an array or object under the
  key, at any depth;
- for password and credential-key assignments, element content such as
  `<password>…</password>` or `<client_secret>…</client_secret>`. Element
  content is judged like a quoted value of an exact key: a password element
  must spell at least eight literal characters after trimming, once its
  references expand (see below).

An *exact* key is the key word alone (`"password"`, `<password>`). A
*prefixed* key has other key text before the word, such as `reset-password`,
`smtp.password` or `"New password"`. A quoted key whose opening quote is
missing on the same line is skipped. A prefixed key's value, and an object
member's value inside a container, count only when they contain no
whitespace, because labels and JSON Schema descriptions are prose. Array
elements under an exact key keep passphrases.

A quoted value with escapes is matched in a neutralized reading, where its
own quote characters and line breaks cannot end it early, and the rule's
predicates (literal length, references, entropy) then judge the same span of
the decoded original, so a decoded quote keeps its meaning. An escaped `\$`
decodes to `$`, as JSON and JavaScript readers decode it.

Each candidate key/value is judged by the rule's own value grammar. The
password rule's literal minimum, the credential-key placeholder exclusions
and the high-entropy predicate therefore carry over. Bare tokens inside a
container are never judged, so `password=[scrubbed]` stays clean. A
structured string literal that spans a raw line break is a host-language
artifact, not a credential. The pass is linear. Nested keys inside a
walked container still get their own scalar check. Each container is walked
at most twice: once for an exact key, whose lenient walk covers everything
inside it, and once for a prefixed key, whose compact walk covers only
other prefixed keys.

A password reference is a placeholder only when it is the whole value
([pm-ycgb5g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ycgb5g.toon);
tracker record excluded from npm). The password rule captures the whole
value and judges the literal it spells once every run-time reference
expands, in one linear pass that follows nesting: `${NAME}`,
`${NAME:?message}`, `$(command)` and `<placeholder>` contribute nothing, and
the word of `${NAME:-word}`, `${NAME:=word}` or `${NAME:+word}` contributes
its own expansion. Quoted text inside a reference never closes it, so
`$(printf ')')` is one reference. An unquoted value's references may nest one
level (`${PW:-${FALLBACK}}`); deeper nesting is followed inside quoted values
and elements. A quoted value ends at its first closing quote, even inside a
reference (`"$(op read "item")"`); the reference it cuts contributes nothing,
so the value stays a placeholder, and a literal after that inner quote is not
measured. The value must spell at least eight literal characters.
So `password=${BUILD_PASSWORD}`, `password=$(op read pw)`,
`password=<placeholder>`, `password=${PREFIX}${SUFFIX}`,
`password=${PRIMARY:-${SECONDARY}}` and an empty default stay clean, while a
literal before or after a reference (`password=${EMPTY}"…"`,
`password=$VAR"…"`, `password="${EMPTY}"…`, `password=…${VAR}`) or a literal
default is reported. A value may hold up to four whitespace-free quoted
pieces, as a shell concatenates them; in source code the quote after a value
usually closes the enclosing string literal, so spaced code after it is never
read as part of the value. A quoted value that holds whitespace (a
passphrase) is that quoted literal alone. A prefixed key's whitespace check
reads the literal, so spaces inside `$(op read pw)` never hide a compact
credential. Element content keeps its quote characters as text, and may hold
markup or placeholder spans (`<password><x>…</password>`). Every scan stays
linear.

A key inside a rejected value keeps its own verdict
([pm-bn3ppf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bn3ppf.toon);
tracker record excluded from npm). A whole-value reference such as a spaced
command substitution spells nothing, so its match is rejected. Each key that
starts inside it is then judged once, so a password assignment written inside
`$(echo …)`, `${…:?…}` or `<…>` is still reported; a key word that names a
braced reference's parameter (`${PASSWORD:OFFSET:8}`) is not an assignment. A rejected inner value
that holds a reference is entered in turn, so a deeper assignment is reached
too. A rejected password value spells fewer literal characters than a key, so
every key inside it sits in a reference body; bodies nest a bounded number of
levels, and the rescan stays linear. Rules with other predicates rely on their
baseline reading instead.

Structured SDK and MCP payloads carry a key as a property name rather than in
the text
([pm-3fbj1f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3fbj1f.toon);
tracker record excluded from npm). A string leaf under a property whose name
ends with a key-named rule's key is judged as that key's value, exactly as the
structured pass judges the payload's JSON spelling `{"<name>": <value>}`: the
same key pattern reads the name, and the rule's own value judge reads the
leaf. A name is read as written, with camelCase words split (`accessToken`
reads as `access_Token`), and with only a prefix split before each of its
last three word boundaries, so `passPhrase`, `APIkey`, `dbPassPhrase` and
`clientAPIkey` keep their keys. As in the JSON spelling, a leaf is judged leniently when its own
exact key names it or when it is an array element under an exact key, and
compactly (whitespace-free) under a prefixed key or as an object member's
value under any credential key above it. The finding reports the leaf's path,
never its value. `{ api_key: "…" }`, `{ clientSecret: "…" }` and
`{ password: ["…"] }` are therefore judged like `{"api_key":"…"}`, and pm's
own fields such as `token_budget`, `max_tokens` and numeric counts stay clean.
A payload string is complete data, so it is judged as a decoded literal
whether or not its JSON spelling needs escapes: its quote characters are
data, and an unclosed reference in it is literal text (the source-text rule
for a reference cut by the grammar never applies). Only strings are judged: a
number, boolean, null or boxed value under a credential key is not a
credential, and the pass never serializes a value or
calls `toJSON`. Each leaf is judged once per rule, so the pass is linear in
the payload. Both passes walk the payload with their own stack, so payload
depth is not limited by the call stack, and a deeply nested credential is
blocked like a shallow one
([pm-wq9njf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wq9njf.toon);
tracker record excluded from npm). A value that is clean only as unquoted code, such as a call or a
statement constant, is a string literal in a payload, as it already is in its
JSON spelling.

Property names are text too
([pm-x07qz2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x07qz2.toon);
tracker record excluded from npm). Every property name in a payload is judged
by every rule as its own leaf, so `{ metadata: { "<token>": true } }` is
reported. A finding for a name carries `property_name: true`. A path never
repeats a flagged name: its segment becomes the positional placeholder
`[key <n>]`, the name's index among its object's own entries, in the name's
own finding and in every finding under it (`$.metadata[key 0].password`).
Paths for other names are unchanged, and array indices are positions, never
judged as names. Each distinct name is judged once per scan. Only a name that
a rule flags on its own is replaced: a name that is not credential-shaped by
itself stays in the path even when it equals a value that another rule flags.

A value too large for a rule's pattern to judge (one of millions of
characters that exhausts the regex stack) fails closed for itself: the guard
reports it under that rule with `normalization_incomplete: true` for explicit
review, and keeps scanning every other leaf, instead of letting the error make
the whole scan fail open. Any other detector error still yields the
`secret_guard_scan_failed_open` advisory.

A private address or host path can be legitimate project context. The default
remains advisory; a workspace selecting `block` must replace those literals
with references or explicitly review a force override. CLI routing paths and
payload content are distinct: pass only content to package-owned preflight.

Home-path detection recognizes concrete POSIX and macOS account roots, root
subdirectories, Windows user profiles, UNC profile shares, DOS device namespace
profiles, and explicit file URLs. Device prefixes follow the
[documented Windows path families](https://learn.microsoft.com/dotnet/standard/io/file-path-formats).
It accepts surrounding markup and punctuation. Detection-only views
decode percent-byte runs, serialized slash/character escapes, and documented
Unicode disguises. Unicode handling applies NFKC, removes zero-width/bidi
controls, and folds division/fraction slashes and Cyrillic look-alikes for the
path vocabulary's letters o and s. These are finite heuristics, not filesystem
canonicalization or a complete confidentiality guarantee.

Inspection is limited to four normalization passes per original line. Findings
can include typed `normalizations` identifiers; original and decoded values are
never returned, and payloads are never rewritten. If encoding remains after the
limit, `normalization_incomplete: true` conservatively requires review using
the same advisory/blocking policy. It applies to the entire string leaf, even
when an earlier line already contained a concrete path. A blocking workspace
may explicitly force a reviewed value. Repository diagnostics retain original source lines, including
when an encoded value contains a newline.

Portable references remain literal: current-user and named tilde references,
home environment variables, and Windows profile variables are not expanded
using the scanner's host. They do not establish a concrete absolute coordinate.
Ordinary web URLs and relative paths are also preserved. Package-specific
policies may classify additional context, but must not treat an empty finding
list as proof that arbitrary content is safe to publish.

Nested settings reads use own properties. Writes reject empty and prototype
path segments before changing any object, create local containers for inherited
values, and define own data properties without invoking inherited setters. Findings expose only the stable rule
name and object path. Matched credential text is never returned, logged, or
included in a recovery bundle.

CLI refusals do not echo URL credentials from the invocation either
([pm-nhauur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nhauur.toon);
tracker record excluded from npm). This applies to typed refusals, Commander
usage errors and bootstrap JSON help, in both JSON and text. Four rules
combine:

- Every refusal builder receives the invocation with each token already
  redacted. Anything a builder derives from it is therefore safe by
  construction, even when it lower-cases, truncates, re-quotes or wraps the
  value.
- Every JSON and text refusal is rendered from one guidance object, and that
  object is redacted before its envelope, its diagnostic budget and its
  output accounting exist, so receipts measure the delivered bytes. Values a
  producer echoed from the raw invocation pass the token rule (argv-token
  fields) or the word rule (free text). Before the word rule runs, a URL
  whose userinfo holds whitespace is joined into one word
  ([pm-gh1773](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1773.toon);
  tracker record excluded from npm). A word opens one at the last `:` that
  authority slashes (any number) follow, so a compact JSON field name before
  the URL is skipped and a URL nested in another one's query is judged; a
  one-letter scheme is a Windows drive (`C:/Temp`), never a URL. When a quote,
  backtick, angle bracket, parenthesis or square bracket directly precedes the
  scheme (a Markdown link destination), its closing delimiter ends the URL (a
  parenthesis or bracket only at the end of a word, so one inside a password is
  data); any other quote is data. The authority after the slashes must hold no path, no closing
  delimiter and no bracketed IPv6 host, and, up to a query or fragment, it
  either holds a `:` and is no dotted or `localhost` `host:port`
  (`https://user:pass`, `https://ci:123456`, `https://ci:pa%40ss`), or holds no
  `:`, `@` or `%40` (`https://service`, `https://jane.doe`: a spaced username,
  whose password colon must come in a later word, with text after it or a tab
  or line break after it, and never as a clock time such as `09:30`, while a
  numeric username part such as `123:pass` counts; a colon directly before the
  `@` is an empty password; a colon
  that a space follows counts only when the separator's host goes on into a
  path, as a URL's does and an email address's never does, or when the quote
  that opened the URL closes it there). A word
  that ends with its slashes continues into the next word, since URL parsers
  drop a tab or line break there. The
  opening word is joined, across any whitespace, through the later word that
  holds the last `@` or `%40` starting within 16 words and 512 characters, as a
  parser takes the authority's last `@`; a word that starts another URL (its
  scheme opens the word, so a redirect inside a query does not), or holds the
  URL's closing delimiter, or, for a WHATWG special scheme (`http`, `https`,
  `ws`, `wss`, `ftp`, `file`), a path delimiter, before any separator, ends the
  search. Any other scheme reads userinfo across slashes, as OpenSSH reads
  `ssh://a/b@host` as user `a/b`. The joined span is redacted exactly as the same
  URL without blanks. So stored text a refusal echoes, such as a blocker title
  holding `https://user:pass words%40host/path`, loses its whole userinfo,
  while `https://host.example:8080 … @bob`, `https://host and ping @bob`,
  `https://host.example?t=12:30 … me@x` and `"https://host" … support: me@x`
  stay intact. A
  producer may also split a value at
  whitespace or a comma, truncate it, re-case it or escape it before echoing
  it. The CLI therefore registers each secret for the running invocation:
  the password, or the whole userinfo of a bare token. The registration also
  holds the secret's shell and JSON escaping, and it removes every run of
  text that shares a six-character fragment with any of them. This bounds
  what any producer can expose to five consecutive secret characters. A
  secret too long for the 65,536-fragment budget is registered at aligned
  positions instead, and the bound widens to `fragmentLength + stride - 2`. The
  registry lives in an AsyncLocalStorage scope, so overlapping in-process
  invocations never share it. It protects telemetry and Sentry as well.
- The rule is conservative. A token is left alone only when no parser can
  read userinfo in it: it uses an `http`, `https`, `ws`, `wss` or `ftp`
  scheme (OpenSSH reads `ssh://a/b@host` as user `a/b`), its authority (the text between the slashes after the
  first `:` and the next `/`; SSH-style parsers read userinfo across `?` and
  `#`) holds no `:`, `@` or percent escape, the rest
  of the token holds no `:` (so no nested URL), and it has no tab or line
  break. `https://www.npmjs.com/package/@unbrained/pm-cli` and blob paths with
  an `@` therefore keep their host, path and executable retry
  ([pm-gh1707](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1707.toon);
  tracker record excluded from npm). Everything else keeps the span from the
  first `:` to the last `@`, so prose shaped like `Reminder: ping @bob` or
  `alias@npm:@scope/pkg@1.0.0` is redacted in refusal output, and that
  invocation's refusals withhold executable retries.
- When the invocation carried credentials, the guidance withholds
  `suggested_retry` and `suggested_retry_args` and gains a final next step
  telling the caller to restore them. JSON and text output therefore agree.

Identities never carry credentials. An asserted or configured author
(`--author`, `PM_AUTHOR`, `default_author`), `--assignee` on create and update,
and identity fields set through runtime or registered field values are refused
with `invalid_argument_value` when they carry URL userinfo. The refusal names
the source but never the value. Refusing rather than stripping keeps two
identities that differ only in userinfo from collapsing into one principal. A
holder stored by an older version still reads unchanged, and ownership checks
compare it exactly, so its owner takes it back with `--force` (a coordinated
takeover) or by rewriting it. Ownership refusals, warn-mode ownership warnings
and claim or release envelopes (`claimed_by`, `previous_assignee`, the
`claim_skipped_held_by` and `claim_takeover` warnings, and the returned item
copy) redact it as one whole value, so whitespace inside its userinfo cannot
split it. Rewrite such a holder with `pm update <id> --assignee <name> --force`
or `pm claim <id> --force`; both refuse without `--force`, because the holder
never matches a caller.

### Executable mutation inventory

`PM_MUTATION_ACTION_CONTRACTS` is the public, typed inventory of core mutation
actions. Each entry identifies whether the action must append item history,
workspace history, or both. Package hosts and quality gates should derive
mutation coverage from this contract instead of maintaining a second command
list.

```ts
import { PM_MUTATION_ACTION_CONTRACTS } from "@unbrained/pm-cli/sdk";

const itemHistoryActions = PM_MUTATION_ACTION_CONTRACTS.filter(
  (contract) => contract.history_scope === "item",
);
```

The contract is a classification primitive, not proof that every handler
actually wrote its required event. The history-completeness release gate must
execute every classified action against a sandbox and assert the resulting
operation and author before the repository can treat that invariant as fully
enforced. Workspace actions remain explicitly classified while that executable
gate is completed.

## Linked-Test JSON Assertions

Tracked by [pm-czr31p](../.agents/pm/issues/pm-czr31p.toon).

JSON assertions accept dotted fields and non-negative safe integer indexes,
such as `result.items[0].count` or `[0][1].count`. The whole path must match:
empty segments, empty brackets, negative indexes, and omitted separators fail
the assertion instead of silently selecting a different field. Traversal reads
only own data properties and never invokes getters or follows prototypes.

## Unknown-Author Disposition

Use `scanHistoryAuthorAttribution` to obtain exact item and one-based line
coordinates. After evidence-backed review, SDK hosts can call
`acknowledgeUnknownAuthorHistoryEvents`. The function validates that every
target is still an actionable unknown-author event and appends
`history:author-acknowledge` to `_workspace.jsonl`.

The same primitive is available as
`pm history-author-acknowledge --event <item-id:line> ...`,
`PmClient.historyAuthorAcknowledge`, and the MCP `pm_run` action
`history-author-acknowledge`. See
[Agent Runtime Primitives](AGENT_RUNTIME_PRIMITIVES.md) for the shared
CLI/SDK/MCP contract.

The acknowledgment includes target coordinates, the attributed principal,
reviewer, and rationale. Subsequent health and validation scans keep the
unknown event in immutable totals but remove it from actionable warnings.

## Stale In-Progress Governance

`scanStaleInProgressItems` combines item metadata with the latest valid history
timestamp. An item is reported only when all three conditions hold:

1. its normalized status matches the configured in-progress status;
2. it has no assignee;
3. its last activity is at least the configured threshold old.

The health result includes deterministic item ordering, age, last activity,
threshold, and remediation. Resolve each finding by claiming genuinely active
work or returning abandoned work to `open`. A direct
`pm update <id> --status in_progress` also emits a stderr-only advisory when
the resulting item would have no assignee; use `pm claim <id>` to make active
ownership explicit. Machine-readable `--json` invocations suppress this
presentation advisory so stderr remains a single parseable error envelope.
