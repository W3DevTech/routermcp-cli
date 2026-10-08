// Generated from https://github.com/W3DevTech/routermcp.git@934729828cae77d09e77f242db0dedcaef28317d:packages/search/src/types.ts. Do not edit.
export const SEARCH_CONTRACT_VERSION = 1 as const;

export const SEARCH_LIMITS = {
  maxCodePoints: 2_048,
  maxUtf8Bytes: 8_192,
  maxClauses: 64,
} as const;

export type SearchEntityType =
  | "project"
  | "server"
  | "tool"
  | "activity"
  | "skill"
  | "registry"
  | "template";

export type SearchSurface =
  | "dashboard"
  | "mcp"
  | "registry"
  | "templates"
  | "activity"
  | "admin"
  | "cli";

export interface SourceSpan {
  /** Unicode code-point offset, inclusive. */
  start: number;
  /** Unicode code-point offset, exclusive. */
  end: number;
}

export type SearchErrorCode =
  | "INVALID_QUERY_TYPE"
  | "QUERY_TOO_LONG"
  | "QUERY_TOO_MANY_BYTES"
  | "TOO_MANY_CLAUSES"
  | "UNCLOSED_QUOTE"
  | "EMPTY_CLAUSE"
  | "EMPTY_QUALIFIER_VALUE"
  | "UNSUPPORTED_SYNTAX"
  | "UNKNOWN_QUALIFIER"
  | "INVALID_QUALIFIER_VALUE"
  | "UNSUPPORTED_QUALIFIER"
  | "INCOMPATIBLE_TYPE"
  | "INVALID_DATE"
  | "INVALID_DATE_RANGE";

export interface SearchDiagnostic {
  code: SearchErrorCode;
  message: string;
  span?: SourceSpan;
}

export class SearchError extends Error {
  override readonly name = "SearchError";

  constructor(
    readonly code: SearchErrorCode,
    message: string,
    readonly span?: SourceSpan,
  ) {
    super(message);
  }

  toDiagnostic(): SearchDiagnostic {
    return {
      code: this.code,
      message: this.message,
      ...(this.span ? { span: this.span } : {}),
    };
  }
}

export type SearchWarningCode = string;

export interface SearchWarning {
  code: SearchWarningCode;
  message: string;
  span?: SourceSpan;
}

export interface ParsedTextClause {
  kind: "text";
  value: string;
  phrase: boolean;
  negated: boolean;
  span: SourceSpan;
}

export interface ParsedQualifierClause {
  kind: "qualifier";
  /** Kept as entered until domain validation resolves aliases and known keys. */
  key: string;
  value: string;
  quoted: boolean;
  negated: boolean;
  span: SourceSpan;
  keySpan: SourceSpan;
  valueSpan: SourceSpan;
}

export type ParsedSearchClause = ParsedTextClause | ParsedQualifierClause;

export interface ParsedSearchQuery {
  version: typeof SEARCH_CONTRACT_VERSION;
  source: string;
  clauses: readonly ParsedSearchClause[];
  warnings: readonly SearchWarning[];
}

export interface SearchDateBound {
  /** Original date or offset-bearing ISO timestamp. */
  input: string;
  /** Canonical UTC timestamp with a preserved fractional second (up to 9 digits). */
  value: string;
  kind: "date" | "timestamp";
  epochSeconds: number;
  nanosecond: number;
}

export type SearchStatus =
  | "enabled"
  | "disabled"
  | "active"
  | "attention"
  | "quiet"
  | "archived"
  | "deleted";

export type SearchEffect = "read" | "write" | "unknown";
export type SearchTransport = "http" | "sse" | "stdio" | "http-streamable";
export type SearchCategory = "role" | "use-case" | "starter";

export interface SearchQualifierValueMap {
  type: SearchEntityType;
  team: string;
  project: string;
  server: string;
  status: SearchStatus;
  cached: boolean;
  effect: SearchEffect;
  transport: SearchTransport;
  tag: string;
  publisher: string;
  verified: boolean;
  featured: boolean;
  category: SearchCategory;
  kind: string;
  after: SearchDateBound;
  before: SearchDateBound;
}

export type SearchQualifierKey = keyof SearchQualifierValueMap;

export type ValidatedQualifierClause = {
  [K in SearchQualifierKey]: {
    kind: "qualifier";
    key: K;
    value: SearchQualifierValueMap[K];
    quoted: boolean;
    negated: boolean;
    span: SourceSpan;
  };
}[SearchQualifierKey];

export type ValidatedTextClause = ParsedTextClause;
export type ValidatedSearchClause = ValidatedTextClause | ValidatedQualifierClause;

export interface SearchQualifierGroup {
  /** Positive values of one key are ORed. */
  include: readonly ValidatedQualifierClause[];
  /** Each negative value excludes a match; nullable fields count as nonmatches. */
  exclude: readonly ValidatedQualifierClause[];
}

export type SearchQualifierGroups = Partial<Record<SearchQualifierKey, SearchQualifierGroup>>;

export interface ValidatedSearchQuery {
  version: typeof SEARCH_CONTRACT_VERSION;
  source: string;
  clauses: readonly ValidatedSearchClause[];
  text: {
    /** Every required text clause must match at least one candidate field. */
    required: readonly ValidatedTextClause[];
    /** Any matching excluded text clause rejects the candidate. */
    excluded: readonly ValidatedTextClause[];
  };
  qualifiers: SearchQualifierGroups;
  /** Domain defaults after explicit type filters and exclusions have been applied. */
  effectiveTypes: readonly SearchEntityType[];
  /** Stable semantic encoding with source order and spans removed. */
  canonical: string;
  warnings: readonly SearchWarning[];
}

export interface SearchValidationContext {
  surface: SearchSurface;
  /** Overrides only implicit result kinds, bounded to kinds available on the surface. */
  defaultTypes?: readonly SearchEntityType[];
  /** Fixes the adapter's result kind and makes entity-specific clauses unambiguous. */
  fixedType?: SearchEntityType;
}

export type SearchFieldValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly (string | number | boolean | Date | null | undefined)[];

export interface SearchMatchAccessors<T> {
  textFields(candidate: T): readonly (string | null | undefined)[];
  qualifierValue(candidate: T, key: SearchQualifierKey): SearchFieldValue;
  /** Catalog-specific equality, especially for stored tag and publisher identifiers. */
  equalsQualifier?(
    key: SearchQualifierKey,
    candidateValue: Exclude<SearchFieldValue, readonly unknown[]>,
    queryValue: SearchQualifierValueMap[SearchQualifierKey],
  ): boolean;
}

export interface ToolRankingCandidate {
  /** Stable callable/catalog key. Keep the runtime's exact dispatch identity here. */
  identity: string;
  /** Human-facing or runtime tool name; may differ from identity. */
  name: string;
  description?: string | null;
}

export type ToolRankingProfile = "hosted" | "cli";

export interface ToolRankingOptions {
  profile: ToolRankingProfile;
  /** CLI compatibility profile defaults to fuzzy matching; hosted has no fuzzy pass. */
  enableFuzzy?: boolean;
  /** Preserve CLI's configured threshold while always excluding zero-score suggestions. */
  minScore?: number;
}

export interface RankedToolCandidate extends ToolRankingCandidate {
  score: number;
}
