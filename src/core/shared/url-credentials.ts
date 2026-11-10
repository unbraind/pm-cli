/**
 * @module core/shared/url-credentials
 * One conservative URL-userinfo redactor for every outbound surface: CLI
 * refusal envelopes, telemetry events and Sentry payloads (pm-nhauur,
 * pm-5htunt).
 */

/** Written where a possible userinfo span was removed. */
export const URL_CREDENTIAL_PLACEHOLDER = "[redacted]";

/**
 * Remove every span of one token that could be URL userinfo. Any URL a parser
 * accepts has a `:` after its scheme, and userinfo always ends at an `@`, so
 * userinfo lies inside the span between the token's first `:` and its last
 * `@`. Replacing that whole span (after any scheme slashes) is complete for
 * every spelling a parser normalizes: backslash authorities, tabs inside a
 * scheme, wrapper chains such as `git+https:` or `npm:`, inline `--flag=value`
 * tokens and single-label or `host:port` authorities. The cost is
 * deliberate: a scoped package name or an `@mention` after a colon is hidden
 * too. The rule is idempotent.
 */
export function redactUrlCredentialsInToken(token: string): string {
  const at = token.lastIndexOf("@");
  const colon = token.indexOf(":");
  if (at < 0 || colon < 0 || colon > at) return token;
  let start = colon + 1;
  while (start < at && (token[start] === "/" || token[start] === "\\")) start += 1;
  return start === at ? token : `${token.slice(0, start)}${URL_CREDENTIAL_PLACEHOLDER}${token.slice(at)}`;
}

/**
 * Apply {@link redactUrlCredentialsInToken} to every whitespace-delimited word
 * of free text. A userinfo span that itself contains whitespace is only
 * removable where the original token is known, as the CLI refusal path does.
 */
export function redactUrlCredentialsInText(text: string): string {
  return text.includes("@") ? text.replaceAll(/\S+/gu, redactUrlCredentialsInToken) : text;
}
