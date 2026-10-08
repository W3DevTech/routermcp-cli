import { createHash } from "node:crypto";
import type { ServerConfig } from "../../config/types.js";
import type { ToolWithSource } from "../aggregator.js";
import {
  compareExplicitSearchOrder,
  matchesSearchQuery,
  parseSearchQuery,
  rankExplicitSearchResult,
  type SearchFieldValue,
  type SearchQualifierKey,
  type SearchWarning,
  type ValidatedSearchQuery,
  validateSearchQuery,
} from "../search/index.js";

export const TOOL_SEARCH_DEFAULT_PAGE_SIZE = 20;
export const TOOL_SEARCH_MAX_PAGE_SIZE = 50;
export const TOOL_SEARCH_MAX_CURSOR_LENGTH = 16_384;

const SEARCH_ORDER = "explicit-search-v1";

export interface ToolSearchPageOptions {
  cursor?: string;
  limit: number;
  includeSchema: boolean;
}

export interface ToolSearchPageItem {
  /** Exact callable identity accepted by the existing execution path. */
  name: string;
  originalName: string;
  serverName: string;
  description: string | null;
  transport?: ServerConfig["transport"];
  inputSchema?: unknown;
}

export interface ToolSearchPage {
  results: ToolSearchPageItem[];
  /** Number of results in this page, not a catalog-wide total. */
  count: number;
  nextCursor: string | null;
  warnings: SearchWarning[];
  coverage: {
    status: "observed";
    scope: "workspace-tool-catalog";
    catalogSize: number;
  };
}

export class ToolSearchCursorError extends Error {
  constructor(
    message: string,
    readonly stale = false,
  ) {
    super(message);
    this.name = "ToolSearchCursorError";
  }
}

interface SearchableTool {
  identity: string;
  source: ToolWithSource;
  candidate: {
    id: string;
    kind: "tool";
    identifier: string;
    label: string;
    description: string;
  };
}

interface ToolSearchCursor {
  version: 1;
  query: string;
  scope: "cli";
  order: typeof SEARCH_ORDER;
  catalog: string;
  limit: number;
  includeSchema: boolean;
  lastIdentity: string;
}

/** Search the workspace-authorized, already-filtered CLI tool catalog. */
export function searchToolCatalog(
  tools: ReadonlyMap<string, ToolWithSource>,
  rawQuery: string,
  options: ToolSearchPageOptions,
): ToolSearchPage {
  const parsed = parseSearchQuery(rawQuery);
  const query = validateSearchQuery(parsed, { surface: "cli" });
  const catalog = Array.from(tools, ([identity, source]) => toSearchableTool(identity, source));
  const catalogFingerprint = fingerprintCatalog(catalog);
  const afterIdentity = options.cursor
    ? decodeCursor(options.cursor, query, catalogFingerprint, options)
    : null;

  const matched = catalog
    .filter((entry) => matchesSearchQuery(query, entry, toolSearchAccessors))
    .map((entry) => ({
      entry,
      order: rankExplicitSearchResult(query, entry.candidate),
    }))
    .sort((left, right) => compareExplicitSearchOrder(left.order, right.order));

  let start = 0;
  if (afterIdentity !== null) {
    const previousIndex = matched.findIndex(({ entry }) => entry.identity === afterIdentity);
    if (previousIndex < 0) {
      throw new ToolSearchCursorError(
        "The previous search page is no longer available. Restart the search without a cursor.",
        true,
      );
    }
    start = previousIndex + 1;
  }

  const page = matched.slice(start, start + options.limit);
  const hasMore = start + page.length < matched.length;
  return {
    results: page.map(({ entry }) => toPageItem(entry, options.includeSchema)),
    count: page.length,
    nextCursor:
      hasMore && page.length > 0
        ? encodeCursor(
            query,
            catalogFingerprint,
            options,
            page[page.length - 1]?.entry.identity ?? "",
          )
        : null,
    warnings: [...query.warnings],
    coverage: {
      status: "observed",
      scope: "workspace-tool-catalog",
      catalogSize: catalog.length,
    },
  };
}

function toSearchableTool(identity: string, source: ToolWithSource): SearchableTool {
  return {
    identity,
    source,
    candidate: {
      id: identity,
      kind: "tool",
      identifier: identity,
      label: source.tool.name,
      description: source.tool.description ?? "",
    },
  };
}

const toolSearchAccessors = {
  textFields: (entry: SearchableTool): Array<string | null | undefined> => [
    entry.source.tool.name,
    entry.identity,
    entry.source.serverName,
    `${entry.source.serverName}.${entry.source.tool.name}`,
    entry.source.tool.description,
  ],
  qualifierValue: (entry: SearchableTool, key: SearchQualifierKey): SearchFieldValue => {
    switch (key) {
      case "type":
        return "tool";
      case "server":
        return entry.source.serverName;
      case "transport":
        return entry.source.transport ?? null;
      default:
        return null;
    }
  },
};

function toPageItem(entry: SearchableTool, includeSchema: boolean): ToolSearchPageItem {
  const { tool, serverName, transport } = entry.source;
  return {
    name: entry.identity,
    originalName: tool.name,
    serverName,
    description: tool.description ?? null,
    ...(transport ? { transport } : {}),
    ...(includeSchema && tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  };
}

function fingerprintCatalog(catalog: readonly SearchableTool[]): string {
  const serialized = catalog
    .map(({ identity, source }) => ({
      identity,
      name: source.tool.name,
      serverName: source.serverName,
      description: source.tool.description ?? null,
      transport: source.transport ?? null,
      inputSchema: stableValue(source.tool.inputSchema),
    }))
    .sort((left, right) => compareCodePoints(left.identity, right.identity));
  return createHash("sha256").update(JSON.stringify(serialized)).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value ?? null;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => [key, stableValue(record[key])]),
  );
}

function encodeCursor(
  query: ValidatedSearchQuery,
  catalog: string,
  options: ToolSearchPageOptions,
  lastIdentity: string,
): string {
  const cursor: ToolSearchCursor = {
    version: 1,
    query: query.canonical,
    scope: "cli",
    order: SEARCH_ORDER,
    catalog,
    limit: options.limit,
    includeSchema: options.includeSchema,
    lastIdentity,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  token: string,
  query: ValidatedSearchQuery,
  catalog: string,
  options: ToolSearchPageOptions,
): string {
  if (token.length > TOOL_SEARCH_MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new ToolSearchCursorError(
      "The search cursor is invalid. Restart the search without a cursor.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new ToolSearchCursorError(
      "The search cursor is invalid. Restart the search without a cursor.",
    );
  }

  if (!isRecord(parsed)) {
    throw new ToolSearchCursorError(
      "The search cursor is invalid. Restart the search without a cursor.",
    );
  }
  const cursor = parsed;

  if (
    cursor.version !== 1 ||
    cursor.scope !== "cli" ||
    cursor.order !== SEARCH_ORDER ||
    typeof cursor.lastIdentity !== "string" ||
    cursor.lastIdentity.length === 0
  ) {
    throw new ToolSearchCursorError(
      "The search cursor is invalid. Restart the search without a cursor.",
    );
  }
  if (
    cursor.query !== query.canonical ||
    cursor.limit !== options.limit ||
    cursor.includeSchema !== options.includeSchema
  ) {
    throw new ToolSearchCursorError(
      "The search cursor does not match this query. Restart the search.",
    );
  }
  if (cursor.catalog !== catalog) {
    throw new ToolSearchCursorError(
      "The tool catalog changed since the previous search page. Restart the search without a cursor.",
      true,
    );
  }
  return cursor.lastIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const leftPoint = a[index]?.codePointAt(0) ?? 0;
    const rightPoint = b[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return a.length - b.length;
}
