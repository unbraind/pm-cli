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
const DEFAULT_SENTRY_REQUEST_TIMEOUT_MS = 120_000;
const MAX_SENTRY_REQUEST_TIMEOUT_MS = 300_000;

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

/** The Sentry API origin the gate queries. */
function sentryBaseUrl() {
  return process.env.SENTRY_URL || process.env.SENTRY_BASE_URL || "https://sentry.io";
}

const SENTRY_GATE_BASE_QUERY = "is:unresolved level:[fatal,error]";
/** Unresolved issues with at least one event outside environment=test, at any time. */
// pm-usn5k2: an event is test traffic when its environment is test or its pm.source_context is test
// (a test child delivering with SENTRY_ENVIRONMENT=ci), so an issue with only such events never blocks.
const SENTRY_NON_TEST_QUERY = `${SENTRY_GATE_BASE_QUERY} !environment:test !pm.source_context:test`;

function buildSentryGateQuery(windowDays) {
  if (windowDays <= 0) {
    return SENTRY_GATE_BASE_QUERY;
  }
  // Bound the gate to issues whose most recent event falls inside the window so a
  // stale, benign unresolved issue that stopped firing long ago no longer blocks
  // every scheduled release. Sentry's relative date syntax `lastSeen:-Nd` matches
  // issues last seen within the past N days.
  return `${SENTRY_GATE_BASE_QUERY} lastSeen:-${windowDays}d`;
}

function buildSentryIssuesUrl(project, query, limit) {
  const baseUrl = sentryBaseUrl();
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

async function enrichSentryIssueWithLatestEvent(
  issue,
  org,
  token,
  requestTimeoutMs,
) {
  if (!needsSentryContractEnrichment(issue) || typeof issue.id !== "string") {
    return issue;
  }
  const baseUrl = sentryBaseUrl();
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
      signal: AbortSignal.timeout(requestTimeoutMs),
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

async function enrichSentryIssuesWithLatestEvents(
  issues,
  project,
  token,
  requestTimeoutMs,
) {
  const { org } = parseSentryProject(project);
  const enriched = [];
  const deadline = Date.now() + requestTimeoutMs;
  for (let index = 0; index < issues.length; index += 10) {
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      enriched.push(...issues.slice(index));
      break;
    }
    const batch = await Promise.all(
      issues
        .slice(index, index + 10)
        .map((issue) =>
          enrichSentryIssueWithLatestEvent(
            issue,
            org,
            token,
            remainingTimeoutMs,
          ),
        ),
    );
    enriched.push(...batch);
  }
  return enriched;
}

function enrichSentryIssuesViaCli(
  issues,
  project,
  windowDays,
  requestTimeoutMs,
) {
  const { org } = parseSentryProject(project);
  const enriched = [];
  const deadline = Date.now() + requestTimeoutMs;
  for (const issue of issues) {
    if (
      !needsSentryContractEnrichment(issue) ||
      typeof issue.shortId !== "string"
    ) {
      enriched.push(issue);
      continue;
    }
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      enriched.push(issue);
      continue;
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
      {
        capture: true,
        allowFailure: true,
        timeout: remainingTimeoutMs,
      },
    );
    if (eventResult.status !== 0) {
      enriched.push(issue);
      continue;
    }
    try {
      const payload =
        eventResult.stdout.trim().length > 0
          ? JSON.parse(eventResult.stdout)
          : [];
      const event = parseIssuePayload(payload)[0];
      if (!event || typeof event !== "object") {
        enriched.push(issue);
        continue;
      }
      enriched.push({
        ...issue,
        tags: event.tags ?? issue.tags,
        metadata: event.metadata ?? issue.metadata,
        release: event.release ?? issue.release,
      });
    } catch {
      enriched.push(issue);
    }
  }
  return enriched;
}

function fetchSentryIssuesViaCli(
  project,
  query,
  limit,
  priorFailure,
  windowDays,
  requestTimeoutMs,
  enrich = true,
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
      timeout: requestTimeoutMs,
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
    const issues = parseIssuePayload(payload);
    return {
      ok: true,
      reason: null,
      token_source: "sentry_cli",
      issues: enrich
        ? enrichSentryIssuesViaCli(issues, project, windowDays, requestTimeoutMs)
        : issues,
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

/** The next page a Sentry Link header announces while it still holds results. */
function nextSentryPage(link) {
  return /<([^>]+)>;\s*rel="next";\s*results="true"/u.exec(link ?? "")?.[1];
}

/**
 * Read issue pages until `limit` issues or the last page: Sentry caps a page at
 * 100 issues and announces the next one in its Link header. Returns the issues
 * and whether more remain, or the HTTP status of a failed page.
 */
async function fetchSentryIssuePages(url, token, limit, requestTimeoutMs) {
  const issues = [];
  for (let page = url; ; ) {
    const response = await fetch(page, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await response.text();
    if (!response.ok) return { status: response.status };
    issues.push(...parseIssuePayload(body.trim().length > 0 ? JSON.parse(body) : []));
    const next = nextSentryPage(response.headers?.get("link"));
    if (next === undefined || issues.length >= limit) {
      return { issues: issues.slice(0, limit), has_more: next !== undefined || issues.length > limit };
    }
    page = next;
  }
}

async function fetchSentryIssues(
  project,
  query,
  limit,
  allowCliFallback,
  windowDays,
  requestTimeoutMs,
  enrich = true,
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
        requestTimeoutMs,
        enrich,
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
      const pages = await fetchSentryIssuePages(url, token, limit, requestTimeoutMs);
      if (pages.status !== undefined) {
        lastFailure = `sentry_api_${pages.status}`;
        continue;
      }
      return {
        ok: true,
        reason: null,
        token_source: tokenSource,
        has_more: pages.has_more,
        issues: enrich
          ? await enrichSentryIssuesWithLatestEvents(pages.issues, project, token, requestTimeoutMs)
          : pages.issues,
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
      requestTimeoutMs,
      enrich,
    );
  }

  return {
    ok: false,
    reason: lastFailure,
    token_source: null,
    issues: [],
  };
}

/** Whether a listing holds every match: no further page and fewer issues than the limit. */
function listingComplete(listing, limit) {
  return listing.has_more !== true && listing.issues.length < limit;
}

/**
 * Drop the active issues whose events are all environment=test (pm-usn5k2): an
 * issue drops out only when a complete listing of issues with any non-test event
 * lacks it. A listing that may be truncated drops nothing.
 */
function excludeTestOnlyIssues(active, nonTest, limit) {
  const complete = listingComplete(nonTest, limit);
  const nonTestIds = new Set(nonTest.issues.map((issue) => issue?.shortId));
  const testOnly = complete
    ? active.issues.filter((issue) => typeof issue?.shortId === "string" && !nonTestIds.has(issue.shortId))
    : [];
  return {
    ...active,
    issues: active.issues.filter((issue) => !testOnly.includes(issue)),
    test_only: testOnly,
    environment_listing_complete: complete,
  };
}

/**
 * The unresolved fatal and error issues the gate judges: active within the window
 * in any environment, minus those seen only in environment=test. Activity and
 * environment are separate queries because Sentry applies lastSeen after an
 * environment filter, so one combined query would also drop an issue whose
 * production event predates the window while a test event falls inside it. A
 * failed environment listing fails the fetch instead of skipping anything, and
 * an active listing cut off at the limit is reported so the gate cannot pass on
 * issues it never read.
 */
async function fetchSentryGateIssues(project, windowDays, limit, allowCliFallback, requestTimeoutMs) {
  const fetched = await fetchSentryIssues(project, buildSentryGateQuery(windowDays), limit, allowCliFallback, windowDays, requestTimeoutMs);
  if (!fetched.ok) return fetched;
  const active = { ...fetched, active_listing_complete: listingComplete(fetched, limit) };
  if (active.issues.length === 0) return active;
  const nonTest = await fetchSentryIssues(project, SENTRY_NON_TEST_QUERY, limit, allowCliFallback, windowDays, requestTimeoutMs, false);
  if (!nonTest.ok) return { ...nonTest, reason: `sentry_environment_query_failed:${nonTest.reason}` };
  return excludeTestOnlyRegressions(excludeTestOnlyIssues(active, nonTest, limit), project, requestTimeoutMs);
}

/** Activity types that record an issue's resolution. */
const SENTRY_RESOLUTION_ACTIVITY_TYPES = new Set([
  "set_resolved",
  "set_resolved_in_release",
  "set_resolved_by_age",
  "set_resolved_in_commit",
  "set_resolved_in_pull_request",
]);
const SENTRY_NON_TEST_EVENT_QUERY = "!environment:test !pm.source_context:test";

/** An ISO 8601 timestamp as Sentry writes them, with a time and an explicit zone. */
const SENTRY_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** Whether the calendar and clock components name a real instant (Date.parse rolls 02-30 into March). */
function isRealCalendarTime([year, month, day, hour, minute, second]) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour < 24 && minute < 60 && second < 60;
}

/**
 * A Sentry timestamp as milliseconds, or NaN for anything but an ISO 8601
 * string with a zone that names a real calendar instant: Date.parse would
 * read an array, a bare "0" or 2026-02-30 as a date. Sub-millisecond digits
 * are dropped, so a tie fails closed.
 */
function parseSentryTime(value) {
  const match = typeof value === "string" ? SENTRY_TIMESTAMP.exec(value) : null;
  return match && isRealCalendarTime(match.slice(1, 7).map(Number)) ? Date.parse(value) : Number.NaN;
}

/**
 * Whether a Link header leaves another page possible, read in any parameter
 * order. Only a missing header means one page; a present one proves the last
 * page only with a well-formed next link (`<target>`) whose results are
 * "false", so an unreadable header never reads as complete.
 */
function sentryLinkHasNextPage(link) {
  if (link === null || link === undefined) return false;
  const next = String(link).split(",").find((part) => /;\s*rel="next"/u.test(part));
  return next === undefined || !/^\s*<[^<>\s]+>/u.test(next) || !/;\s*results="false"/u.test(next);
}

/** The latest activity entry of the given types, with its time, or undefined. */
function latestActivity(activity, types) {
  let latest;
  for (const entry of activity) {
    const time = parseSentryTime(entry.dateCreated);
    if (types.has(entry.type) && (latest === undefined || time > latest.time)) latest = { entry, time };
  }
  return latest;
}

const SENTRY_REGRESSION_ACTIVITY_TYPES = new Set(["set_regression"]);
/** Sentry accepts event timestamps somewhat off its own clock, so the event window extends on both sides. */
const SENTRY_EVENT_WINDOW_SKEW_MS = 60 * 60 * 1000;
/** Attempts per lookup, the first included, when Sentry throttles it. */
const SENTRY_LOOKUP_ATTEMPTS = 3;
/** Events read per regression: Sentry caps a `full=true` page at 10, and an issue with more non-test events keeps blocking. */
const SENTRY_REGRESSION_EVENT_LIMIT = 10;

/** The wait a 429 asks for: Retry-After as delay seconds or as an HTTP date, else one second. */
function retryAfterMs(response) {
  const header = response.headers?.get("retry-after");
  const text = typeof header === "string" ? header.trim() : "";
  const seconds = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = text.length > 0 ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1000;
}

/** The JSON body of an OK response and whether another page follows, or undefined for a failed or empty one. */
async function readSentryPage(response) {
  if (!response.ok) return undefined;
  const body = await response.text();
  return body.trim().length > 0 ? { json: JSON.parse(body), hasNext: sentryLinkHasNextPage(response.headers?.get("link")) } : undefined;
}

/**
 * One authorized read within a shared deadline. No request starts, and no
 * response is accepted, once the deadline has passed. A 429 is retried after
 * its Retry-After delay while the deadline allows; any other failure or an
 * empty body yields undefined.
 */
async function fetchSentryPage(url, token, deadline) {
  for (let attempt = 1; ; attempt += 1) {
    if (Date.now() >= deadline) return undefined;
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (response.status !== 429) {
      // The body counts against the budget too: a page read after the deadline is not accepted.
      const page = await readSentryPage(response);
      return Date.now() > deadline ? undefined : page;
    }
    const delay = retryAfterMs(response);
    // No attempt follows the last one, so it is not worth a wait.
    if (attempt >= SENTRY_LOOKUP_ATTEMPTS || Date.now() + delay >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * When the issue was last resolved, from an activity feed whose resolutions
 * and regressions are all dated and whose latest regression follows the
 * latest resolution; undefined otherwise, so an unorderable feed never falls
 * back to an older cycle.
 */
async function readLatestResolutionTime(issueUrl, token, deadline) {
  const activity = (await fetchSentryPage(issueUrl, token, deadline))?.json?.activity;
  const transitions = (Array.isArray(activity) ? activity : []).filter(
    (entry) => SENTRY_RESOLUTION_ACTIVITY_TYPES.has(entry?.type) || SENTRY_REGRESSION_ACTIVITY_TYPES.has(entry?.type),
  );
  if (transitions.some((entry) => !Number.isFinite(parseSentryTime(entry.dateCreated)))) return undefined;
  const resolution = latestActivity(transitions, SENTRY_RESOLUTION_ACTIVITY_TYPES);
  const regression = latestActivity(transitions, SENTRY_REGRESSION_ACTIVITY_TYPES);
  // A regression stamped at the resolution's own instant is not ordered after it.
  return resolution !== undefined && regression !== undefined && regression.time > resolution.time ? resolution.time : undefined;
}

/**
 * Whether a regressed issue regressed only through test traffic (pm-kxmu54):
 * every non-test event the issue ever had (environment and pm.source_context
 * not test) was received before its latest resolution, so whoever resolved it
 * judged them all and what reopened it is test traffic, as pm-usn5k2 treats an
 * issue made only of test events. Receipt time, not the event's own
 * timestamp, decides, so a late production event with an old timestamp still
 * blocks. Any failed or truncated lookup, or a missing or unorderable record,
 * keeps the issue blocking.
 */
async function isTestOnlyRegression(issue, org, token, deadline) {
  const firstSeen = parseSentryTime(issue?.firstSeen);
  if (issue?.substatus !== "regressed" || typeof issue.id !== "string" || !Number.isFinite(firstSeen)) return false;
  const issueUrl = new URL(`/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issue.id)}/`, sentryBaseUrl());
  try {
    const resolvedAt = await readLatestResolutionTime(issueUrl, token, deadline);
    if (resolvedAt === undefined) return false;
    const eventsUrl = new URL("events/", issueUrl);
    eventsUrl.searchParams.set("query", SENTRY_NON_TEST_EVENT_QUERY);
    eventsUrl.searchParams.set("full", "true");
    eventsUrl.searchParams.set("per_page", String(SENTRY_REGRESSION_EVENT_LIMIT));
    eventsUrl.searchParams.set("start", new Date(firstSeen - SENTRY_EVENT_WINDOW_SKEW_MS).toISOString());
    eventsUrl.searchParams.set("end", new Date(Date.now() + SENTRY_EVENT_WINDOW_SKEW_MS).toISOString());
    const page = await fetchSentryPage(eventsUrl, token, deadline);
    if (page === undefined || page.hasNext || !Array.isArray(page.json)) return false;
    return page.json.every((event) => parseSentryTime(event?.dateReceived) < resolvedAt);
  } catch {
    return false;
  }
}

/** Move the issues that regressed only through test traffic to the test-only set; needs the API token the listing used. */
async function excludeTestOnlyRegressions(partitioned, project, requestTimeoutMs) {
  const token = redactedTokenCandidates().find(([source]) => source === partitioned.token_source)?.[1];
  if (token === undefined) return partitioned;
  const { org } = parseSentryProject(project);
  // One lookup at a time within one budget: Sentry rate-limits issue details per organization.
  const deadline = Date.now() + requestTimeoutMs;
  const verdicts = [];
  for (const issue of partitioned.issues) verdicts.push(await isTestOnlyRegression(issue, org, token, deadline));
  const regressions = partitioned.issues.filter((_issue, index) => verdicts[index]);
  if (regressions.length === 0) return partitioned;
  return {
    ...partitioned,
    issues: partitioned.issues.filter((_issue, index) => !verdicts[index]),
    test_only: [...partitioned.test_only, ...regressions],
    test_only_regressions: regressions,
  };
}

function usage() {
  console.log(`Usage:
  node scripts/release/sentry-telemetry-gate.mjs [--json]
    [--sentry-project unbrained/pm-cli]
    [--sentry-limit 200]
    [--sentry-window-days 14]
    [--sentry-request-timeout-ms 120000]
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

function parseNumber(
  value,
  key,
  fallback,
  { integer = false, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {},
) {
  if (value == null) {
    return fallback;
  }
  // `Number("")` / `Number("   ")` coerce to 0, which would silently disable a
  // numeric guard (e.g. an empty `--sentry-window-days` would mean "unbounded");
  // reject blank values explicitly instead of accepting a surprise zero.
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
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
        request_timeout_ms: params.sentryRequestTimeoutMs,
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
      ignored_test_only_total: (params.sentryFetch.test_only ?? []).length,
      ignored_test_only_short_ids: (params.sentryFetch.test_only ?? [])
        .map((issue) => issue.shortId)
        .slice(0, 25),
      ignored_test_only_regression_short_ids: (params.sentryFetch.test_only_regressions ?? [])
        .map((issue) => issue.shortId)
        .slice(0, 25),
      environment_listing_complete:
        params.sentryFetch.environment_listing_complete ?? null,
      active_listing_complete:
        params.sentryFetch.active_listing_complete ?? null,
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

/** The Sentry side passes only with access, a complete active listing and tallies within both thresholds. */
function isSentryThresholdOk(sentryFetch, sentryAccessOk, sentrySummary, maxCritical, maxHigh) {
  return (
    sentryAccessOk &&
    sentryFetch.active_listing_complete !== false &&
    sentrySummary.critical <= maxCritical &&
    sentrySummary.high <= maxHigh
  );
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
  const sentryRequestTimeoutMs = parseNumber(
    flagString(flags, "sentry-request-timeout-ms", null),
    "sentry-request-timeout-ms",
    DEFAULT_SENTRY_REQUEST_TIMEOUT_MS,
    {
      integer: true,
      minimum: 1,
      maximum: MAX_SENTRY_REQUEST_TIMEOUT_MS,
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
  const sentryFetch = await fetchSentryGateIssues(
    sentryProject,
    sentryWindowDays,
    sentryLimit,
    allowSentryCliFallback,
    sentryRequestTimeoutMs,
  );
  const sentryIssues = sentryFetch.ok ? sentryFetch.issues : [];
  const sentryPartition = partitionSentryIssuesForGate(sentryIssues);
  const sentrySummary = sentrySeverityTally(sentryPartition.relevant);
  const sentryAccessOk = sentryFetch.ok || !sentryAccessRequired;
  const sentryThresholdOk = isSentryThresholdOk(sentryFetch, sentryAccessOk, sentrySummary, maxCritical, maxHigh);

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
    sentryRequestTimeoutMs,
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
