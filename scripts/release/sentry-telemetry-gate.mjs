#!/usr/bin/env node

import { fail, flagBool, flagString, parseFlags, runCommand } from "./utils.mjs";

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

function usage() {
  console.log(`Usage:
  node scripts/release/sentry-telemetry-gate.mjs [--json]
    [--sentry-project unbrained/pm-cli]
    [--sentry-limit 200]
    [--max-critical 0]
    [--max-high 0]
    [--telemetry-mode off|best-effort|required]
    [--telemetry-days 7]
    [--max-telemetry-error-rate 6]
    [--max-telemetry-missing-error-rows 0]

Blocks release automation when Sentry or telemetry reliability thresholds are exceeded.
`);
}

function parseNumber(value, key, fallback) {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`Invalid --${key} value "${value}".`);
  }
  return parsed;
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const sentryProject = flagString(flags, "sentry-project", "unbrained/pm-cli");
  const sentryLimit = parseNumber(flagString(flags, "sentry-limit", null), "sentry-limit", 200);
  const maxCritical = parseNumber(flagString(flags, "max-critical", null), "max-critical", 0);
  const maxHigh = parseNumber(flagString(flags, "max-high", null), "max-high", 0);
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
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

  const sentryResult = runCommand(
    "sentry",
    [
      "issue",
      "list",
      sentryProject,
      "--query",
      "is:unresolved level:[fatal,error]",
      "--limit",
      String(sentryLimit),
      "--json",
      "--fields",
      "shortId,title,level,priority,status,count",
    ],
    { capture: true },
  );
  const sentryPayload = JSON.parse(sentryResult.stdout.trim() || "{}");
  const sentryIssues = parseIssuePayload(sentryPayload);
  const sentrySummary = sentrySeverityTally(sentryIssues);
  const sentryThresholdOk = sentrySummary.critical <= maxCritical && sentrySummary.high <= maxHigh;

  let telemetrySummary = {
    checked: false,
    mode: telemetryMode,
    ok: true,
    warning: null,
    finish_error_rate_pct: null,
    failures_without_error_code_rows: null,
  };

  if (telemetryMode !== "off") {
    const telemetryCommand = runCommand(
      "bash",
      ["scripts/prod/telemetry/query-telemetry.sh", "--days", String(telemetryDays), "--limit", "50"],
      {
        capture: true,
        allowFailure: telemetryMode !== "required",
      },
    );

    if (telemetryCommand.status === 0) {
      const metrics = parseTelemetryMetrics(telemetryCommand.stdout);
      if (!metrics.ok) {
        telemetrySummary = {
          checked: true,
          mode: telemetryMode,
          ok: false,
          warning: metrics.reason,
          finish_error_rate_pct: null,
          failures_without_error_code_rows: null,
        };
      } else {
        const thresholdOk =
          metrics.finish_error_rate_pct <= maxTelemetryErrorRate &&
          metrics.failures_without_error_code_rows <= maxTelemetryMissingRows;
        telemetrySummary = {
          checked: true,
          mode: telemetryMode,
          ok: thresholdOk,
          warning: null,
          finish_error_rate_pct: metrics.finish_error_rate_pct,
          failures_without_error_code_rows: metrics.failures_without_error_code_rows,
        };
      }
    } else {
      telemetrySummary = {
        checked: true,
        mode: telemetryMode,
        ok: telemetryMode === "best-effort",
        warning: telemetryCommand.stderr.trim() || "telemetry_query_failed",
        finish_error_rate_pct: null,
        failures_without_error_code_rows: null,
      };
    }
  }

  const ok = sentryThresholdOk && telemetrySummary.ok;
  const result = {
    ok,
    thresholds: {
      sentry: {
        max_critical: maxCritical,
        max_high: maxHigh,
      },
      telemetry: {
        mode: telemetryMode,
        max_error_rate_pct: maxTelemetryErrorRate,
        max_missing_error_code_rows: maxTelemetryMissingRows,
      },
    },
    sentry: {
      project: sentryProject,
      critical: sentrySummary.critical,
      high: sentrySummary.high,
      total: sentrySummary.total,
      threshold_ok: sentryThresholdOk,
    },
    telemetry: telemetrySummary,
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ok) {
    console.log(
      `Sentry/telemetry gate passed (critical=${sentrySummary.critical}, high=${sentrySummary.high}, telemetry_mode=${telemetryMode}).`,
    );
  } else {
    console.error(
      `Sentry/telemetry gate failed (critical=${sentrySummary.critical}, high=${sentrySummary.high}, telemetry_mode=${telemetryMode}).`,
    );
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

main();
