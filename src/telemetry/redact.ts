import { homedir } from "node:os";

export const REDACTED = "<redacted>";

/**
 * Keep only the shape of the command line: flag names survive, every value
 * (flag values, positional arguments, commands passed to --stdio) is dropped.
 * The subcommand is reported separately, so nothing useful is lost.
 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    if (!arg.startsWith("-") || arg === "-" || arg === "--") {
      return REDACTED;
    }
    const equals = arg.indexOf("=");
    return equals === -1 ? arg : `${arg.slice(0, equals)}=${REDACTED}`;
  });
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]+/gi;
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PAIR_PATTERN =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi;
const AUTH_SCHEME_PATTERN = /^(bearer|basic)$/i;

/**
 * Scrub free text (error messages, stack traces) before it leaves the
 * machine: the home directory becomes `~`, URLs lose credentials, query
 * strings and fragments, and bearer tokens or `token=...` pairs are masked.
 */
export function redactText(text: string, home: string = homedir()): string {
  let result = text;
  if (home && home !== "/") {
    result = result.split(home).join("~");
  }
  result = result.replace(URL_PATTERN, redactUrl);
  result = result.replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  result = result.replace(
    SECRET_PAIR_PATTERN,
    (match, key: string, separator: string, value: string) =>
      // "Authorization: Bearer <redacted>" was already handled above.
      AUTH_SCHEME_PATTERN.test(value) || value.startsWith(REDACTED)
        ? match
        : `${key}${separator}${REDACTED}`,
  );
  return result;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hadSecrets = Boolean(url.username || url.password || url.search || url.hash);
    if (!hadSecrets) return raw;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${REDACTED}`;
  } catch {
    return REDACTED;
  }
}
