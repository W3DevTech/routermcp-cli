// Generated from https://github.com/W3DevTech/routermcp.git@934729828cae77d09e77f242db0dedcaef28317d:packages/search/src/parser.ts. Do not edit.
import {
  type ParsedSearchClause,
  type ParsedSearchQuery,
  SEARCH_CONTRACT_VERSION,
  SEARCH_LIMITS,
  type SearchDiagnostic,
  SearchError,
  type SearchWarning,
  type SourceSpan,
} from "./types";

const EMPTY_WARNINGS: readonly SearchWarning[] = [];

export type SearchParseResult =
  | { ok: true; query: ParsedSearchQuery; warnings: readonly SearchWarning[] }
  | { ok: false; error: SearchDiagnostic; warnings: readonly SearchWarning[] };

/** Parse the portable v1 grammar. Offsets count Unicode code points, not UTF-16 units. */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  if (typeof input !== "string") {
    throw new SearchError("INVALID_QUERY_TYPE", "Search query must be a string.");
  }

  const chars = Array.from(input);
  const codePoints = chars.length;
  const byteLength = new TextEncoder().encode(input).length;
  if (byteLength > SEARCH_LIMITS.maxUtf8Bytes) {
    throw new SearchError(
      "QUERY_TOO_MANY_BYTES",
      `Search query exceeds ${SEARCH_LIMITS.maxUtf8Bytes} UTF-8 bytes.`,
      { start: 0, end: codePoints },
    );
  }
  if (codePoints > SEARCH_LIMITS.maxCodePoints) {
    throw new SearchError(
      "QUERY_TOO_LONG",
      `Search query exceeds ${SEARCH_LIMITS.maxCodePoints} Unicode code points.`,
      { start: SEARCH_LIMITS.maxCodePoints, end: codePoints },
    );
  }

  const clauses: ParsedSearchClause[] = [];
  let cursor = 0;
  while (cursor < codePoints) {
    while (cursor < codePoints && isWhitespace(chars[cursor] ?? "")) cursor++;
    if (cursor >= codePoints) break;

    if (clauses.length >= SEARCH_LIMITS.maxClauses) {
      throw new SearchError(
        "TOO_MANY_CLAUSES",
        `Search query exceeds ${SEARCH_LIMITS.maxClauses} clauses.`,
        { start: cursor, end: clauseEnd(chars, cursor) },
      );
    }

    const start = cursor;
    let negated = false;
    if (chars[cursor] === "-") {
      negated = true;
      cursor++;
      if (cursor >= codePoints || isWhitespace(chars[cursor] ?? "")) {
        throw new SearchError(
          "EMPTY_CLAUSE",
          "A negation marker must precede a term or qualifier.",
          {
            start,
            end: cursor,
          },
        );
      }
    }

    const tokenStart = cursor;
    if (isParenthesis(chars[cursor] ?? "")) {
      throw unsupportedSyntax(
        "Parentheses are not supported in search queries.",
        start,
        cursor + 1,
      );
    }

    if (chars[cursor] === '"') {
      const quoted = readQuoted(chars, cursor);
      cursor = quoted.next;
      requireClauseBoundary(chars, cursor, codePoints, start);
      if (quoted.value.length === 0) {
        throw new SearchError("EMPTY_CLAUSE", "Quoted search phrases cannot be empty.", {
          start,
          end: cursor,
        });
      }
      clauses.push({
        kind: "text",
        value: quoted.value,
        phrase: true,
        negated,
        span: { start, end: cursor },
      });
      continue;
    }

    const separator = findQualifierSeparator(chars, tokenStart);
    if (separator !== null) {
      const key = chars.slice(tokenStart, separator).join("");
      if (isIdentifier(key)) {
        const keySpan = { start: tokenStart, end: separator };
        cursor = separator + 1;
        const valueStart = cursor;
        let value = "";
        let quoted = false;
        if (chars[cursor] === '"') {
          const parsed = readQuoted(chars, cursor);
          value = parsed.value;
          cursor = parsed.next;
          quoted = true;
          requireClauseBoundary(chars, cursor, codePoints, start);
        } else {
          while (cursor < codePoints && !isWhitespace(chars[cursor] ?? "")) {
            if (isParenthesis(chars[cursor] ?? "")) {
              throw unsupportedSyntax(
                "Parentheses are not supported in search queries.",
                start,
                cursor + 1,
              );
            }
            if (chars[cursor] === '"') {
              throw new SearchError(
                "UNSUPPORTED_SYNTAX",
                'Quote a complete qualifier value, for example server:"my server".',
                { start: cursor, end: cursor + 1 },
              );
            }
            value += chars[cursor] ?? "";
            cursor++;
          }
        }
        if (value.length === 0) {
          throw new SearchError("EMPTY_QUALIFIER_VALUE", `Qualifier ${key} needs a value.`, {
            start: valueStart,
            end: cursor,
          });
        }
        const valueEnd = cursor;
        clauses.push({
          kind: "qualifier",
          key,
          value,
          quoted,
          negated,
          span: { start, end: cursor },
          keySpan,
          valueSpan: { start: valueStart, end: valueEnd },
        });
        continue;
      }
    }

    while (cursor < codePoints && !isWhitespace(chars[cursor] ?? "")) {
      if (isParenthesis(chars[cursor] ?? "")) {
        throw unsupportedSyntax(
          "Parentheses are not supported in search queries.",
          start,
          cursor + 1,
        );
      }
      if (chars[cursor] === '"') {
        throw new SearchError(
          "UNSUPPORTED_SYNTAX",
          "Quote a complete phrase instead of placing a quote inside a bare term.",
          { start: cursor, end: cursor + 1 },
        );
      }
      cursor++;
    }

    const value = chars.slice(tokenStart, cursor).join("");
    if (value.length === 0) {
      throw new SearchError("EMPTY_CLAUSE", "Expected a search term.", { start, end: cursor });
    }
    if (/^(?:and|or)$/iu.test(value)) {
      throw unsupportedSyntax(
        `Explicit ${value.toUpperCase()} operators are not supported; terms are combined with AND.`,
        start,
        cursor,
      );
    }
    clauses.push({
      kind: "text",
      value,
      phrase: false,
      negated,
      span: { start, end: cursor },
    });
  }

  return {
    version: SEARCH_CONTRACT_VERSION,
    source: input,
    clauses,
    warnings: EMPTY_WARNINGS,
  };
}

/** Parse without exceptions when an adapter wants to map diagnostics into its own envelope. */
export function tryParseSearchQuery(input: string): SearchParseResult {
  try {
    const query = parseSearchQuery(input);
    return { ok: true, query, warnings: query.warnings };
  } catch (error) {
    if (!(error instanceof SearchError)) throw error;
    return { ok: false, error: error.toDiagnostic(), warnings: EMPTY_WARNINGS };
  }
}

function findQualifierSeparator(chars: readonly string[], start: number): number | null {
  for (let index = start; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (isWhitespace(char) || char === '"' || isParenthesis(char)) return null;
    if (char === ":") return index;
  }
  return null;
}

function isIdentifier(value: string): boolean {
  return /^[\p{L}][\p{L}\p{N}_-]*$/u.test(value);
}

function isWhitespace(value: string): boolean {
  return /^\s$/u.test(value);
}

function isParenthesis(value: string): boolean {
  return value === "(" || value === ")";
}

function clauseEnd(chars: readonly string[], start: number): number {
  let end = start;
  while (end < chars.length && !isWhitespace(chars[end] ?? "")) end++;
  return end;
}

function requireClauseBoundary(
  chars: readonly string[],
  cursor: number,
  length: number,
  clauseStart: number,
): void {
  if (cursor < length && !isWhitespace(chars[cursor] ?? "")) {
    throw new SearchError(
      "UNSUPPORTED_SYNTAX",
      "Separate a quoted phrase or qualifier value from the next clause with whitespace.",
      { start: clauseStart, end: cursor + 1 },
    );
  }
}

function readQuoted(chars: readonly string[], start: number): { value: string; next: number } {
  let cursor = start + 1;
  let value = "";
  while (cursor < chars.length) {
    const char = chars[cursor] ?? "";
    if (char === '"') return { value, next: cursor + 1 };
    if (char === "\\" && (chars[cursor + 1] === '"' || chars[cursor + 1] === "\\")) {
      value += chars[cursor + 1] ?? "";
      cursor += 2;
      continue;
    }
    value += char;
    cursor++;
  }
  throw new SearchError("UNCLOSED_QUOTE", "Close the quoted search phrase with a double quote.", {
    start,
    end: chars.length,
  });
}

function unsupportedSyntax(message: string, start: number, end: number): SearchError {
  return new SearchError("UNSUPPORTED_SYNTAX", message, { start, end } satisfies SourceSpan);
}
