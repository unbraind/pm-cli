#!/usr/bin/env node

import { existsSync } from "node:fs";
import { commandFor, fail, flagBool, flagString, parseFlags, runCommand } from "./utils.mjs";

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
    rows.push(Object.fromEntries(header.map((key, tokenIndex) => [key, tokens[tokenIndex]])));
  }
  return { header, rows };
}

function parseTelemetryMetrics(output) {
  const overall = parseCsvSection(output, "overall finish error rate");
  const missingCoverage = parseCsvSection(output, "missing error code coverage");
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

const KNOWN_IGNORED_CONSOLE_ISSUE_PATTERNS = [
  "[starter-extension] activating",
  "all 8 capabilities registered.",
  "[starter-extension] commands:",
  "[starter] preflight check for workspace",
  "[starter] output_format service override active",
  "[pm-ext-ts-starter] activating",
  "[pm-ext-ts-starter] all capabilities registered.",
  "run `pm init` first to initialise a pm workspace",
];
const KNOWN_EXPECTED_HANDLED_CLI_ISSUE_PATTERNS = [
  "authentication required, not authenticated",
  // Count-agnostic handled apply failures from issue-sync/dogfood paths:
  // "All N item(s) failed to apply ...; no issues were created or updated."
  "item(s) failed to apply",
  "csv is missing required 'title' column",
  "dependency cycle",
  "failed to fetch issues from jira",
  "no items imported",
  "no slack webhook configured",
  "slack webhook request failed",
  "slack webhook returned http",
  // Count-agnostic: validation / preflight structural-error CommandErrors are
  // expected handled CLI failures regardless of how many errors are reported
  // ("validation failed: N", "validation found N", "N structural error(s) found
  // in", "preflight: N structural error(s)"). The brittle per-count list missed
  // new counts (e.g. 4) and re-blocked the release on dogfood smoke output.
  "structural error(s)",
  // Handled write failure surfaced by the standup-export dogfood step when the
  // target's parent directory is missing ("could not write to <path>: the parent
  // directory does not exist — create it first ..."). Expected handled CLI error.
  "the parent directory does not exist",
  // Structured problem+json payload for commands run before a tracker exists.
  // This is a handled CLI usage error, not an unhandled runtime failure.
  "tracker_not_initialized",
  // Expected handled failures from package dogfood/release-smoke commands.
  // These stay behind the CommandError/PmCliError + isUnhandled=false guard.
  "pm-web exited with code",
  "github api returned http 422",
  "drift detected:",
];
const KNOWN_EXPECTED_HANDLED_ENVIRONMENT_ISSUE_PATTERNS = [
  // Local disk exhaustion is an operational host-capacity failure surfaced by
  // Node as Error/ENOSPC, not a pm-cli crash. It remains relevant in telemetry
  // but should not block releases when the CLI caught and reported it.
  "enospc: no space left on device",
];

function issueTextValue(issue) {
  const metadata = issue && typeof issue === "object" ? issue.metadata : null;
  const metadataValue = metadata && typeof metadata.value === "string" ? metadata.value : "";
  const title = issue && typeof issue.title === "string" ? issue.title : "";
  return `${title}\n${metadataValue}`;
}

function isIgnoredConsoleNoiseIssue(issue) {
  const logger = String(issue?.logger ?? "").toLowerCase();
  if (logger !== "console") {
    return false;
  }
  const combinedText = issueTextValue(issue).toLowerCase();
  return KNOWN_IGNORED_CONSOLE_ISSUE_PATTERNS.some((pattern) => combinedText.includes(pattern));
}

function isExpectedHandledCliIssue(issue) {
  const metadata = issue && typeof issue === "object" ? issue.metadata : null;
  const type = metadata && typeof metadata.type === "string" ? metadata.type : "";
  if ((type !== "PmCliError" && type !== "CommandError") || issue?.isUnhandled === true) {
    return false;
  }
  const combinedText = issueTextValue(issue).toLowerCase();
  return KNOWN_EXPECTED_HANDLED_CLI_ISSUE_PATTERNS.some((pattern) => combinedText.includes(pattern));
}

function isExpectedHandledEnvironmentIssue(issue) {
  const metadata = issue && typeof issue === "object" ? issue.metadata : null;
  const type = metadata && typeof metadata.type === "string" ? metadata.type : "";
  if (type !== "Error" || issue?.isUnhandled === true) {
    return false;
  }
  const combinedText = issueTextValue(issue).toLowerCase();
  return KNOWN_EXPECTED_HANDLED_ENVIRONMENT_ISSUE_PATTERNS.some((pattern) => combinedText.includes(pattern));
}

function partitionSentryIssuesForGate(issues) {
  const relevant = [];
  const ignoredNoise = [];
  const ignoredExpected = [];
  for (const issue of issues) {
    if (isIgnoredConsoleNoiseIssue(issue)) {
      ignoredNoise.push(issue);
      continue;
    }
    if (isExpectedHandledCliIssue(issue)) {
      ignoredExpected.push(issue);
      continue;
    }
    if (isExpectedHandledEnvironmentIssue(issue)) {
      ignoredExpected.push(issue);
      continue;
    }
    relevant.push(issue);
  }
  return { relevant, ignoredNoise, ignoredExpected };
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
  const baseUrl = process.env.SENTRY_URL || process.env.SENTRY_BASE_URL || "https://sentry.io";
  const { org, projectSlug } = parseSentryProject(project);
  const url = new URL(`/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(projectSlug)}/issues/`, baseUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  return url;
}

function fetchSentryIssuesViaCli(project, query, limit, priorFailure) {
  const result = runCommand(
    commandFor("sentry"),
    [
      "issue",
      "list",
      project,
      "--json",
      "--fields",
      "shortId,title,level,priority,status,culprit,metadata,logger,isUnhandled",
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
      reason: stderr.length > 0 ? `sentry_cli_query_failed:${stderr}` : priorFailure,
      token_source: null,
      issues: [],
    };
  }

  try {
    const payload = result.stdout.trim().length > 0 ? JSON.parse(result.stdout) : [];
    return {
      ok: true,
      reason: null,
      token_source: "sentry_cli",
      issues: parseIssuePayload(payload),
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

async function fetchSentryIssues(project, query, limit, allowCliFallback) {
  const tokens = redactedTokenCandidates();
  if (tokens.length === 0) {
    if (allowCliFallback) {
      return fetchSentryIssuesViaCli(project, query, limit, "missing_sentry_auth_token");
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
      return {
        ok: true,
        reason: null,
        token_source: tokenSource,
        issues: parseIssuePayload(payload),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = `sentry_query_error:${message}`;
    }
  }

  if (allowCliFallback) {
    return fetchSentryIssuesViaCli(project, query, limit, lastFailure);
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
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
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

function buildTelemetrySummaryFromCommand(telemetryCommand, telemetryMode, maxTelemetryErrorRate, maxTelemetryMissingRows) {
  if (telemetryCommand.status !== 0) {
    const stderr = typeof telemetryCommand.stderr === "string" ? telemetryCommand.stderr.trim() : "";
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

function runTelemetryGateCommand(telemetryCommandPath, telemetryDays, telemetryMode) {
  const telemetryInvocation = telemetryCommandPath
    ? buildTelemetryCommandInvocation(telemetryCommandPath, telemetryDays)
    : null;
  return telemetryInvocation
    ? runCommand(
        telemetryInvocation.command,
        telemetryInvocation.args,
        {
          capture: true,
          allowFailure: telemetryMode !== "required",
        },
      )
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
    fail("telemetry_query_command_missing: set --telemetry-command or PM_TELEMETRY_QUERY_COMMAND to a private/local telemetry query adapter");
  }
  return buildTelemetrySummaryFromCommand(
    runTelemetryGateCommand(params.telemetryCommandPath, params.telemetryDays, params.telemetryMode),
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
      token_source: params.sentryFetch.ok ? params.sentryFetch.token_source : null,
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
      ignored_noise_total: params.sentryPartition.ignoredNoise.length,
      ignored_noise_short_ids: params.sentryPartition.ignoredNoise
        .map((issue) => issue?.shortId)
        .filter((value) => typeof value === "string")
        .slice(0, 25),
      ignored_expected_handled_total: params.sentryPartition.ignoredExpected.length,
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
    `sentry_window_days=${context.sentryWindowDays}, ignored_noise=${context.sentryPartition.ignoredNoise.length}, ` +
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
  const sentryLimit = parseNumber(flagString(flags, "sentry-limit", null), "sentry-limit", 200);
  // Sentry's relative-date syntax (`lastSeen:-Nd`) only accepts whole days, so a
  // decimal window would yield a malformed query (400 / ignored filter); require
  // an integer day count.
  const sentryWindowDays = parseNumber(flagString(flags, "sentry-window-days", null), "sentry-window-days", 14, {
    integer: true,
  });
  const maxCritical = parseNumber(flagString(flags, "max-critical", null), "max-critical", 0);
  const maxHigh = parseNumber(flagString(flags, "max-high", null), "max-high", 0);
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
  const telemetryCommandPath =
    flagString(flags, "telemetry-command", null) ??
    process.env.PM_TELEMETRY_QUERY_COMMAND ??
    (existsSync("scripts/prod/telemetry/query-telemetry.sh") ? "scripts/prod/telemetry/query-telemetry.sh" : null);
  const telemetryDays = parseNumber(flagString(flags, "telemetry-days", null), "telemetry-days", 7);
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
    fail(`Unsupported --telemetry-mode value "${telemetryMode}". Use off, best-effort, or required.`);
  }

  const sentryFetch = await fetchSentryIssues(
    sentryProject,
    buildSentryGateQuery(sentryWindowDays),
    sentryLimit,
    telemetryMode === "required",
  );
  const sentryIssues = sentryFetch.ok ? sentryFetch.issues : [];
  const sentryPartition = partitionSentryIssuesForGate(sentryIssues);
  const sentrySummary = sentrySeverityTally(sentryPartition.relevant);
  const sentryAccessRequired = telemetryMode === "required" || redactedTokenCandidates().length > 0;
  const sentryAccessOk = sentryFetch.ok || !sentryAccessRequired;
  const sentryThresholdOk =
    sentryAccessOk && sentrySummary.critical <= maxCritical && sentrySummary.high <= maxHigh;

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

  printSentryTelemetryGateResult(result, outputJson, { sentrySummary, sentryWindowDays, sentryPartition, telemetryMode });

  if (!ok) {
    process.exitCode = 1;
  }
}

main();
