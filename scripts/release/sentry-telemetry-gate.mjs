#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  PM_ERROR_CODE_CATALOG,
  resolveCanonicalPmErrorCodeContract,
} from "../../dist/sdk/contracts.js";
import {
  commandFor,
  fail,
  flagBool,
  flagString,
  parseFlags,
  runCommand,
} from "./utils.mjs";

function parseIssuePayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function parseCsvSection(output, title) {
  const marker = `### ${title}`;
  const start = output.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const nextStart = output.indexOf("\n### ", start + marker.length);
  const block = output.slice(start, nextStart === -1 ? undefined : nextStart);
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const headerIndex = lines.findIndex((line) => line.includes(","));
  if (headerIndex === -1) {
    return { header: [], rows: [] };
  }
  const header = lines[headerIndex].split(",").map((token) => token.trim());
  const rows = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\(\d+\s+rows?\)$/i.test(line)) {
      break;
    }
    if (!line.includes(",")) {
      continue;
    }
    const tokens = line.split(",").map((token) => token.trim());
    if (tokens.length !== header.length) {
      continue;
    }
    rows.push(
      Object.fromEntries(
        header.map((key, tokenIndex) => [key, tokens[tokenIndex]]),
      ),
    );
  }
  return { header, rows };
}

function parseTelemetryMetrics(output) {
  const overall = parseCsvSection(output, "overall finish error rate");
  const missingCoverage = parseCsvSection(
    output,
    "missing error code coverage",
  );
  if (!overall || overall.rows.length === 0) {
    return {
      ok: false,
      reason: "missing_overall_finish_error_rate_section",
      finish_error_rate_pct: null,
      failures_without_error_code_rows: null,
    };
  }
  const firstOverall = overall.rows[0];
  const finishErrorRate = Number(firstOverall.finish_error_rate_pct ?? "NaN");
  if (!Number.isFinite(finishErrorRate)) {
    return {
      ok: false,
      reason: "invalid_finish_error_rate_value",
      finish_error_rate_pct: null,
      failures_without_error_code_rows: null,
    };
  }

  const missingRows = missingCoverage ? missingCoverage.rows.length : 0;
  return {
    ok: true,
    reason: null,
    finish_error_rate_pct: finishErrorRate,
    failures_without_error_code_rows: missingRows,
  };
}

function sentrySeverityTally(issues) {
  const summary = {
    critical: 0,
    high: 0,
    total: issues.length,
  };
  for (const issue of issues) {
    const level = String(issue.level ?? "").toLowerCase();
    const priority = String(issue.priority ?? "").toLowerCase();
    if (level === "fatal") {
      summary.critical += 1;
      continue;
    }
    if (level === "error" || priority === "high") {
      summary.high += 1;
    }
  }
  return summary;
}

const EXPECTED_HANDLED_ERROR_CLASSES = new Set([
  "usage",
  "not_found",
  "conflict",
]);

const SENTRY_ERROR_CONTRACT_MIN_PRODUCER_VERSION = "2026.8.7";

function readIssueTag(issue, key) {
  if (!issue || typeof issue !== "object") {
    return undefined;
  }
  if (Array.isArray(issue.tags)) {
    const tag = issue.tags.find((candidate) => candidate?.key === key);
    return typeof tag?.value === "string" ? tag.value : undefined;
  }
  if (issue.tags && typeof issue.tags === "object") {
    const value = issue.tags[key];
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
  }
  return undefined;
}

function readIssueContractValue(issue, snakeKey, tagKey) {
  if (!issue || typeof issue !== "object") {
    return undefined;
  }
  const metadata =
    issue.metadata && typeof issue.metadata === "object"
      ? issue.metadata
      : null;
  const extra =
    issue.extra && typeof issue.extra === "object" ? issue.extra : null;
  const candidates = [
    issue[snakeKey],
    metadata?.[snakeKey],
    metadata?.[tagKey],
    extra?.[snakeKey],
    extra?.[tagKey],
    readIssueTag(issue, tagKey),
  ];
  return candidates.find(
    (candidate) =>
      typeof candidate === "string" || typeof candidate === "number",
  );
}

function isExpectedHandledCliIssue(issue) {
  if (issue?.isUnhandled === true || readIssueTag(issue, "handled") === "no") {
    return false;
  }
  const errorCode = readIssueContractValue(
    issue,
    "error_code",
    "pm.error_code",
  );
  const exitCode = Number(
    readIssueContractValue(issue, "exit_code", "pm.exit_code"),
  );
  if (typeof errorCode !== "string" || !Number.isInteger(exitCode)) {
    return false;
  }
  try {
    const contract = resolveCanonicalPmErrorCodeContract(
      errorCode,
      PM_ERROR_CODE_CATALOG,
    );
    return (
      contract.exit_code === exitCode &&
      EXPECTED_HANDLED_ERROR_CLASSES.has(contract.class)
    );
  } catch {
    return false;
  }
}

function readIssueProducerVersion(issue) {
  const candidates = [
    issue?.release,
    issue?.lastRelease?.version,
    issue?.firstRelease?.version,
    readIssueTag(issue, "release"),
    readIssueTag(issue, "pm.release"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = /(?:^|@|v)(\d{4}\.\d{1,2}\.\d{1,2})(?:$|[-+])/u.exec(
      candidate.trim(),
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function isLegacyPreContractIssue(issue) {
  const version = readIssueProducerVersion(issue);
  if (version === null) return false;
  const current = version.split(".").map(Number);
  const minimum = SENTRY_ERROR_CONTRACT_MIN_PRODUCER_VERSION.split(".").map(
    Number,
  );
  return current.some(
    (part, index) =>
      part < minimum[index] &&
      current.slice(0, index).every((value, prior) => value === minimum[prior]),
  );
}

function partitionSentryIssuesForGate(issues) {
  const relevant = [];
  const ignoredExpected = [];
  const legacyPreContract = [];
  for (const issue of issues) {
    if (isExpectedHandledCliIssue(issue)) {
      ignoredExpected.push(issue);
      continue;
    }
    if (isLegacyPreContractIssue(issue)) {
      legacyPreContract.push(issue);
      continue;
    }
    relevant.push(issue);
  }
  return { relevant, ignoredExpected, legacyPreContract };
}

function redactedTokenCandidates() {
  const candidates = [
    ["SENTRY_AUTH_TOKEN", process.env.SENTRY_AUTH_TOKEN],
    ["SENTRY_PERSONAL_ADMIN_TOKEN", process.env.SENTRY_PERSONAL_ADMIN_TOKEN],
    ["SENTRY_ORG_TOKEN", process.env.SENTRY_ORG_TOKEN],
  ];
  const seen = new Set();
  return candidates.filter(([, value]) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function parseSentryProject(project) {
  const [org, projectSlug, ...extra] = project.split("/");
  if (!org || !projectSlug || extra.length > 0) {
    fail(`Invalid --sentry-project value "${project}". Expected org/project.`);
  }
  return { org, projectSlug };
}

function buildSentryGateQuery(windowDays) {
  const baseQuery = "is:unresolved level:[fatal,error]";
  if (windowDays <= 0) {
    return baseQuery;
  }
  // Bound the gate to issues whose most recent event falls inside the window so a
  // stale, benign unresolved issue that stopped firing long ago no longer blocks
  // every scheduled release. Sentry's relative date syntax `lastSeen:-Nd` matches
  // issues last seen within the past N days.
  return `${baseQuery} lastSeen:-${windowDays}d`;
}

function buildSentryIssuesUrl(project, query, limit) {
  const baseUrl =
    process.env.SENTRY_URL ||
    process.env.SENTRY_BASE_URL ||
    "https://sentry.io";
  const { org, projectSlug } = parseSentryProject(project);
  const url = new URL(
    `/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/issues/`,
    baseUrl,
  );
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  return url;
}

function needsSentryContractEnrichment(issue) {
  return Boolean(
    issue &&
    typeof issue === "object" &&
    issue.isUnhandled !== true &&
    (readIssueContractValue(issue, "error_code", "pm.error_code") ===
      undefined ||
      readIssueContractValue(issue, "exit_code", "pm.exit_code") === undefined),
  );
}

async function enrichSentryIssueWithLatestEvent(issue, org, token) {
  if (!needsSentryContractEnrichment(issue) || typeof issue.id !== "string") {
    return issue;
  }
  const baseUrl =
    process.env.SENTRY_URL ||
    process.env.SENTRY_BASE_URL ||
    "https://sentry.io";
  const eventUrl = new URL(
    `/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issue.id)}/events/latest/`,
    baseUrl,
  );
  try {
    const response = await fetch(eventUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return issue;
    }
    const body = await response.text();
    const event = body.trim().length > 0 ? JSON.parse(body) : null;
    if (!event || typeof event !== "object") {
      return issue;
    }
    return {
      ...issue,
      tags: event.tags ?? issue.tags,
      extra: event.extra ?? issue.extra,
      contexts: event.contexts ?? issue.contexts,
      release: event.release ?? issue.release,
    };
  } catch {
    return issue;
  }
}

async function enrichSentryIssuesWithLatestEvents(issues, project, token) {
  const { org } = parseSentryProject(project);
  const enriched = [];
  for (let index = 0; index < issues.length; index += 10) {
    const batch = await Promise.all(
      issues
        .slice(index, index + 10)
        .map((issue) => enrichSentryIssueWithLatestEvent(issue, org, token)),
    );
    enriched.push(...batch);
  }
  return enriched;
}

function enrichSentryIssuesViaCli(issues, project, windowDays) {
  const { org } = parseSentryProject(project);
  return issues.map((issue) => {
    if (
      !needsSentryContractEnrichment(issue) ||
      typeof issue.shortId !== "string"
    ) {
      return issue;
    }
    const eventResult = runCommand(
      commandFor("sentry"),
      [
        "issue",
        "events",
        `${org}/${issue.shortId}`,
        "--limit",
        "1",
        "--period",
        `${windowDays > 0 ? windowDays : 90}d`,
        "--fresh",
        "--json",
        "--fields",
        "tags,metadata,release",
      ],
      { capture: true, allowFailure: true },
    );
    if (eventResult.status !== 0) {
      return issue;
    }
    try {
      const payload =
        eventResult.stdout.trim().length > 0
          ? JSON.parse(eventResult.stdout)
          : [];
      const event = parseIssuePayload(payload)[0];
      if (!event || typeof event !== "object") {
        return issue;
      }
      return {
        ...issue,
        tags: event.tags ?? issue.tags,
        metadata: event.metadata ?? issue.metadata,
        release: event.release ?? issue.release,
      };
    } catch {
      return issue;
    }
  });
}

function fetchSentryIssuesViaCli(
  project,
  query,
  limit,
  priorFailure,
  windowDays,
) {
  const result = runCommand(
    commandFor("sentry"),
    [
      "issue",
      "list",
      project,
      "--json",
      "--fields",
      "shortId,title,level,priority,status,culprit,metadata,logger,isUnhandled,lastRelease,firstRelease",
      "--query",
      query,
      "--limit",
      String(limit),
    ],
    {
      capture: true,
      allowFailure: true,
    },
  );
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      reason:
        stderr.length > 0 ? `sentry_cli_query_failed:${stderr}` : priorFailure,
      token_source: null,
      issues: [],
    };
  }

  try {
    const payload =
      result.stdout.trim().length > 0 ? JSON.parse(result.stdout) : [];
    return {
      ok: true,
      reason: null,
      token_source: "sentry_cli",
      issues: enrichSentryIssuesViaCli(
        parseIssuePayload(payload),
        project,
        windowDays,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `sentry_cli_json_parse_failed:${message}`,
      token_source: null,
      issues: [],
    };
  }
}

async function fetchSentryIssues(
  project,
  query,
  limit,
  allowCliFallback,
  windowDays,
) {
  const tokens = redactedTokenCandidates();
  if (tokens.length === 0) {
    if (allowCliFallback) {
      return fetchSentryIssuesViaCli(
        project,
        query,
        limit,
        "missing_sentry_auth_token",
        windowDays,
      );
    }
    return {
      ok: false,
      reason: "missing_sentry_auth_token",
      token_source: null,
      issues: [],
    };
  }

  const url = buildSentryIssuesUrl(project, query, limit);
  let lastFailure = "sentry_query_failed";
  for (const [tokenSource, token] of tokens) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      if (!response.ok) {
        lastFailure = `sentry_api_${response.status}`;
        continue;
      }
      const payload = body.trim().length > 0 ? JSON.parse(body) : [];
      const issues = parseIssuePayload(payload);
      return {
        ok: true,
        reason: null,
        token_source: tokenSource,
        issues: await enrichSentryIssuesWithLatestEvents(
          issues,
          project,
          token,
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = `sentry_query_error:${message}`;
    }
  }

  if (allowCliFallback) {
    return fetchSentryIssuesViaCli(
      project,
      query,
      limit,
      lastFailure,
      windowDays,
    );
  }

  return {
    ok: false,
    reason: lastFailure,
    token_source: null,
    issues: [],
  };
}

function usage() {
  console.log(`Usage:
  node scripts/release/sentry-telemetry-gate.mjs [--json]
    [--sentry-project unbrained/pm-cli]
    [--sentry-limit 200]
    [--sentry-window-days 14]
    [--max-critical 0]
    [--max-high 0]
    [--telemetry-mode off|best-effort|required]
    [--telemetry-command scripts/prod/telemetry/query-telemetry.sh]
    [--telemetry-days 7]
    [--max-telemetry-error-rate 6]
    [--max-telemetry-missing-error-rows 0]

Blocks release automation when Sentry or telemetry reliability thresholds are exceeded.
`);
}

function parseNumber(value, key, fallback, { integer = false } = {}) {
  if (value == null) {
    return fallback;
  }
  // `Number("")` / `Number("   ")` coerce to 0, which would silently disable a
  // numeric guard (e.g. an empty `--sentry-window-days` would mean "unbounded");
  // reject blank values explicitly instead of accepting a surprise zero.
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (integer && !Number.isInteger(parsed))
  ) {
    fail(`Invalid --${key} value "${value}".`);
  }
  return parsed;
}

function buildTelemetryCommandInvocation(commandPath, telemetryDays) {
  const args = ["--days", String(telemetryDays), "--limit", "50"];
  if (commandPath.endsWith(".sh")) {
    return {
      command: "bash",
      args: [commandPath, ...args],
    };
  }
  return {
    command: commandPath,
    args,
  };
}

function buildInitialTelemetrySummary(telemetryMode) {
  return {
    checked: false,
    mode: telemetryMode,
    ok: true,
    warning: null,
    finish_error_rate_pct: null,
    failures_without_error_code_rows: null,
  };
}

function buildTelemetrySummaryFromCommand(
  telemetryCommand,
  telemetryMode,
  maxTelemetryErrorRate,
  maxTelemetryMissingRows,
) {
  if (telemetryCommand.status !== 0) {
    const stderr =
      typeof telemetryCommand.stderr === "string"
        ? telemetryCommand.stderr.trim()
        : "";
    return {
      checked: true,
      mode: telemetryMode,
      ok: telemetryMode === "best-effort",
      warning: stderr || "telemetry_query_failed",
      finish_error_rate_pct: null,
      failures_without_error_code_rows: null,
    };
  }
  const metrics = parseTelemetryMetrics(telemetryCommand.stdout);
  if (!metrics.ok) {
    return {
      checked: true,
      mode: telemetryMode,
      ok: false,
      warning: metrics.reason,
      finish_error_rate_pct: null,
      failures_without_error_code_rows: null,
    };
  }
  return {
    checked: true,
    mode: telemetryMode,
    ok:
      metrics.finish_error_rate_pct <= maxTelemetryErrorRate &&
      metrics.failures_without_error_code_rows <= maxTelemetryMissingRows,
    warning: null,
    finish_error_rate_pct: metrics.finish_error_rate_pct,
    failures_without_error_code_rows: metrics.failures_without_error_code_rows,
  };
}

function runTelemetryGateCommand(
  telemetryCommandPath,
  telemetryDays,
  telemetryMode,
) {
  const telemetryInvocation = telemetryCommandPath
    ? buildTelemetryCommandInvocation(telemetryCommandPath, telemetryDays)
    : null;
  return telemetryInvocation
    ? runCommand(telemetryInvocation.command, telemetryInvocation.args, {
        capture: true,
        allowFailure: telemetryMode !== "required",
      })
    : {
        status: 127,
        stdout: "",
        stderr:
          "telemetry_query_command_missing: set --telemetry-command or PM_TELEMETRY_QUERY_COMMAND to a private/local telemetry query adapter",
      };
}

function resolveTelemetrySummary(params) {
  if (params.telemetryMode === "off") {
    return buildInitialTelemetrySummary(params.telemetryMode);
  }
  if (params.telemetryMode === "required" && !params.telemetryCommandPath) {
    fail(
      "telemetry_query_command_missing: set --telemetry-command or PM_TELEMETRY_QUERY_COMMAND to a private/local telemetry query adapter",
    );
  }
  return buildTelemetrySummaryFromCommand(
    runTelemetryGateCommand(
      params.telemetryCommandPath,
      params.telemetryDays,
      params.telemetryMode,
    ),
    params.telemetryMode,
    params.maxTelemetryErrorRate,
    params.maxTelemetryMissingRows,
  );
}

function buildSentryTelemetryGateResult(params) {
  return {
    ok: params.ok,
    thresholds: {
      sentry: {
        max_critical: params.maxCritical,
        max_high: params.maxHigh,
        minimum_contract_producer_version:
          SENTRY_ERROR_CONTRACT_MIN_PRODUCER_VERSION,
      },
      telemetry: {
        mode: params.telemetryMode,
        max_error_rate_pct: params.maxTelemetryErrorRate,
        max_missing_error_code_rows: params.maxTelemetryMissingRows,
      },
    },
    sentry: {
      project: params.sentryProject,
      window_days: params.sentryWindowDays,
      checked: params.sentryFetch.ok,
      warning: params.sentryFetch.ok ? null : params.sentryFetch.reason,
      token_source: params.sentryFetch.ok
        ? params.sentryFetch.token_source
        : null,
      critical: params.sentrySummary.critical,
      high: params.sentrySummary.high,
      total: params.sentrySummary.total,
      blocking_short_ids: params.sentryPartition.relevant
        .map((issue) => issue?.shortId)
        .filter((value) => typeof value === "string")
        .slice(0, 25),
      blocking_titles: params.sentryPartition.relevant
        .map((issue) => issue?.title)
        .filter((value) => typeof value === "string")
        .slice(0, 8),
      blocking_reasons: params.sentryPartition.relevant
        .map((issue) => ({
          short_id: typeof issue?.shortId === "string" ? issue.shortId : null,
          reason: needsSentryContractEnrichment(issue)
            ? "missing_contract_tags"
            : "unexpected_fault",
        }))
        .slice(0, 25),
      legacy_pre_contract_total:
        params.sentryPartition.legacyPreContract.length,
      legacy_pre_contract_short_ids: params.sentryPartition.legacyPreContract
        .map((issue) => issue?.shortId)
        .filter((value) => typeof value === "string")
        .slice(0, 25),
      ignored_noise_total: 0,
      ignored_noise_short_ids: [],
      ignored_expected_handled_total:
        params.sentryPartition.ignoredExpected.length,
      ignored_expected_handled_short_ids: params.sentryPartition.ignoredExpected
        .map((issue) => issue?.shortId)
        .filter((value) => typeof value === "string")
        .slice(0, 25),
      access_ok: params.sentryAccessOk,
      threshold_ok: params.sentryThresholdOk,
    },
    telemetry: params.telemetrySummary,
  };
}

function printSentryTelemetryGateResult(result, outputJson, context) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const message =
    `Sentry/telemetry gate ${result.ok ? "passed" : "failed"} ` +
    `(critical=${context.sentrySummary.critical}, high=${context.sentrySummary.high}, ` +
    `sentry_window_days=${context.sentryWindowDays}, ignored_noise=0, ` +
    `ignored_expected_handled=${context.sentryPartition.ignoredExpected.length}, telemetry_mode=${context.telemetryMode}).`;
  if (result.ok) {
    console.log(message);
  } else {
    console.error(message);
  }
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const sentryProject = flagString(flags, "sentry-project", "unbrained/pm-cli");
  const sentryLimit = parseNumber(
    flagString(flags, "sentry-limit", null),
    "sentry-limit",
    200,
  );
  // Sentry's relative-date syntax (`lastSeen:-Nd`) only accepts whole days, so a
  // decimal window would yield a malformed query (400 / ignored filter); require
  // an integer day count.
  const sentryWindowDays = parseNumber(
    flagString(flags, "sentry-window-days", null),
    "sentry-window-days",
    14,
    {
      integer: true,
    },
  );
  const maxCritical = parseNumber(
    flagString(flags, "max-critical", null),
    "max-critical",
    0,
  );
  const maxHigh = parseNumber(
    flagString(flags, "max-high", null),
    "max-high",
    0,
  );
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
  const telemetryCommandPath =
    flagString(flags, "telemetry-command", null) ??
    process.env.PM_TELEMETRY_QUERY_COMMAND ??
    (existsSync("scripts/prod/telemetry/query-telemetry.sh")
      ? "scripts/prod/telemetry/query-telemetry.sh"
      : null);
  const telemetryDays = parseNumber(
    flagString(flags, "telemetry-days", null),
    "telemetry-days",
    7,
  );
  const maxTelemetryErrorRate = parseNumber(
    flagString(flags, "max-telemetry-error-rate", null),
    "max-telemetry-error-rate",
    6,
  );
  const maxTelemetryMissingRows = parseNumber(
    flagString(flags, "max-telemetry-missing-error-rows", null),
    "max-telemetry-missing-error-rows",
    0,
  );

  if (!["off", "best-effort", "required"].includes(telemetryMode)) {
    fail(
      `Unsupported --telemetry-mode value "${telemetryMode}". Use off, best-effort, or required.`,
    );
  }

  const sentryTokenConfigured = redactedTokenCandidates().length > 0;
  const sentryAccessRequired =
    telemetryMode === "required" || sentryTokenConfigured;
  const allowSentryCliFallback =
    telemetryMode === "required" ||
    (telemetryMode === "best-effort" && sentryTokenConfigured);
  const sentryFetch = await fetchSentryIssues(
    sentryProject,
    buildSentryGateQuery(sentryWindowDays),
    sentryLimit,
    allowSentryCliFallback,
    sentryWindowDays,
  );
  const sentryIssues = sentryFetch.ok ? sentryFetch.issues : [];
  const sentryPartition = partitionSentryIssuesForGate(sentryIssues);
  const sentrySummary = sentrySeverityTally(sentryPartition.relevant);
  const sentryAccessOk = sentryFetch.ok || !sentryAccessRequired;
  const sentryThresholdOk =
    sentryAccessOk &&
    sentrySummary.critical <= maxCritical &&
    sentrySummary.high <= maxHigh;

  const telemetrySummary = resolveTelemetrySummary({
    telemetryMode,
    telemetryCommandPath,
    telemetryDays,
    maxTelemetryErrorRate,
    maxTelemetryMissingRows,
  });

  const ok = sentryThresholdOk && telemetrySummary.ok;
  const result = buildSentryTelemetryGateResult({
    ok,
    maxCritical,
    maxHigh,
    telemetryMode,
    maxTelemetryErrorRate,
    maxTelemetryMissingRows,
    sentryProject,
    sentryWindowDays,
    sentryFetch,
    sentrySummary,
    sentryPartition,
    sentryAccessOk,
    sentryThresholdOk,
    telemetrySummary,
  });

  printSentryTelemetryGateResult(result, outputJson, {
    sentrySummary,
    sentryWindowDays,
    sentryPartition,
    telemetryMode,
  });

  if (!ok) {
    process.exitCode = 1;
  }
}

main();
