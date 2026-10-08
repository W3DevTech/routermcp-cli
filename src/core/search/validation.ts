// Generated from https://github.com/W3DevTech/routermcp.git@934729828cae77d09e77f242db0dedcaef28317d:packages/search/src/validation.ts. Do not edit.
import { compareDateBounds, parseDateBound } from "./date";
import {
  type ParsedQualifierClause,
  type ParsedSearchQuery,
  type SearchCategory,
  type SearchDateBound,
  type SearchEffect,
  type SearchEntityType,
  SearchError,
  type SearchQualifierGroups,
  type SearchQualifierKey,
  type SearchStatus,
  type SearchSurface,
  type SearchTransport,
  type SearchValidationContext,
  type ValidatedQualifierClause,
  type ValidatedSearchClause,
  type ValidatedSearchQuery,
} from "./types";

export { compareDateBounds, parseDateBound } from "./date";

const ENTITY_TYPES: readonly SearchEntityType[] = [
  "project",
  "server",
  "tool",
  "activity",
  "skill",
  "registry",
  "template",
];

const SURFACE_TYPES: Record<SearchSurface, readonly SearchEntityType[]> = {
  dashboard: ["project", "server", "tool", "activity", "skill"],
  mcp: ["tool"],
  registry: ["registry"],
  templates: ["template"],
  activity: ["activity"],
  admin: ["project", "server", "tool", "activity", "skill", "registry", "template"],
  cli: ["tool"],
};

const SURFACE_DEFAULTS: Record<SearchSurface, readonly SearchEntityType[]> = {
  dashboard: ["project", "server", "tool"],
  mcp: ["tool"],
  registry: ["registry"],
  templates: ["template"],
  activity: ["activity"],
  admin: ["project", "server", "tool", "activity", "skill", "registry", "template"],
  cli: ["tool"],
};

const SUPPORTED_QUALIFIERS: Record<SearchSurface, readonly SearchQualifierKey[]> = {
  dashboard: [
    "type",
    "team",
    "project",
    "server",
    "status",
    "cached",
    "effect",
    "transport",
    "kind",
    "after",
    "before",
  ],
  mcp: ["type", "project", "server", "status"],
  registry: ["type", "transport", "tag", "publisher", "verified", "featured"],
  templates: ["type", "tag", "category"],
  activity: ["type", "kind", "after", "before"],
  admin: [
    "type",
    "team",
    "project",
    "server",
    "status",
    "cached",
    "effect",
    "transport",
    "tag",
    "publisher",
    "verified",
    "featured",
    "category",
    "kind",
    "after",
    "before",
  ],
  cli: ["type", "server", "transport"],
};

const KNOWN_KEYS = new Set<SearchQualifierKey>([
  "type",
  "team",
  "project",
  "server",
  "status",
  "cached",
  "effect",
  "transport",
  "tag",
  "publisher",
  "verified",
  "featured",
  "category",
  "kind",
  "after",
  "before",
]);

const EFFECTS: readonly SearchEffect[] = ["read", "write", "unknown"];
const CATEGORIES: readonly SearchCategory[] = ["role", "use-case", "starter"];
const TYPE_REQUIRING_SINGLE_ENTITY: readonly SearchQualifierKey[] = [
  "status",
  "cached",
  "effect",
  "transport",
  "tag",
  "publisher",
  "verified",
  "featured",
  "category",
  "kind",
  "after",
  "before",
];

export type SearchValidationResult =
  | { ok: true; query: ValidatedSearchQuery; warnings: readonly [] }
  | { ok: false; error: ReturnType<SearchError["toDiagnostic"]>; warnings: readonly [] };

/** Canonicalize qualifier keys and values and enforce surface/entity compatibility. */
export function validateSearchQuery(
  parsed: ParsedSearchQuery,
  context: SearchValidationContext,
): ValidatedSearchQuery {
  const surfaceTypes = SURFACE_TYPES[context.surface];
  if (!surfaceTypes) {
    throw new SearchError("UNSUPPORTED_QUALIFIER", `Unknown search surface: ${context.surface}.`);
  }

  const defaults = context.defaultTypes ?? SURFACE_DEFAULTS[context.surface];
  const fixedType = context.fixedType;
  if (fixedType && !surfaceTypes.includes(fixedType)) {
    throw new SearchError(
      "INCOMPATIBLE_TYPE",
      `Search type ${fixedType} is not available on the ${context.surface} surface.`,
    );
  }
  for (const type of defaults) {
    if (!surfaceTypes.includes(type)) {
      throw new SearchError(
        "INCOMPATIBLE_TYPE",
        `Default search type ${type} is not available on the ${context.surface} surface.`,
      );
    }
  }

  const clauses: ValidatedSearchClause[] = [];
  for (const clause of parsed.clauses) {
    if (clause.kind === "text") {
      clauses.push(clause);
      continue;
    }
    clauses.push(validateQualifier(clause, context.surface));
  }

  const explicitTypes = clauses.filter(
    (clause): clause is Extract<ValidatedQualifierClause, { key: "type" }> =>
      clause.kind === "qualifier" && clause.key === "type",
  );
  validateExplicitTypes(explicitTypes, context, surfaceTypes);
  const positiveTypes = explicitTypes
    .filter((clause) => !clause.negated)
    .map((clause) => clause.value);
  const negativeTypes = explicitTypes
    .filter((clause) => clause.negated)
    .map((clause) => clause.value);
  const allowedTypes = fixedType ? [fixedType] : [...defaults];
  const typeCandidates = positiveTypes.length > 0 ? unique(positiveTypes) : allowedTypes;
  const effectiveTypes = unique(typeCandidates)
    .filter((type) => surfaceTypes.includes(type))
    .filter((type) => !negativeTypes.includes(type));

  validateReferenceApplicability(clauses, context, effectiveTypes);
  validateTypeApplicability(clauses, context, effectiveTypes);
  validateDateRange(clauses);

  const textRequired = clauses.filter(
    (clause): clause is Extract<ValidatedSearchClause, { kind: "text" }> =>
      clause.kind === "text" && !clause.negated,
  );
  const textExcluded = clauses.filter(
    (clause): clause is Extract<ValidatedSearchClause, { kind: "text" }> =>
      clause.kind === "text" && clause.negated,
  );
  const qualifiers = groupQualifiers(clauses);
  const canonical = canonicalize(clauses);

  return {
    version: parsed.version,
    source: parsed.source,
    clauses,
    text: { required: textRequired, excluded: textExcluded },
    qualifiers,
    effectiveTypes,
    canonical,
    warnings: parsed.warnings,
  };
}

export function tryValidateSearchQuery(
  parsed: ParsedSearchQuery,
  context: SearchValidationContext,
): SearchValidationResult {
  try {
    const query = validateSearchQuery(parsed, context);
    return { ok: true, query, warnings: [] };
  } catch (error) {
    if (!(error instanceof SearchError)) throw error;
    return { ok: false, error: error.toDiagnostic(), warnings: [] };
  }
}

function validateQualifier(
  parsed: ParsedQualifierClause,
  surface: SearchSurface,
): ValidatedQualifierClause {
  const inputKey = normalizeKey(parsed.key);
  const key = inputKey === "entity" ? "type" : inputKey;
  if (!KNOWN_KEYS.has(key as SearchQualifierKey)) {
    throw new SearchError(
      "UNKNOWN_QUALIFIER",
      `Unknown search qualifier ${parsed.key}. If the colon is part of text such as a URL, quote the whole text. Supported qualifiers include type, team, project, server, status, effect, transport, tag, category, kind, after, and before.`,
      parsed.keySpan,
    );
  }
  const typedKey = key as SearchQualifierKey;
  if (!SUPPORTED_QUALIFIERS[surface].includes(typedKey)) {
    throw new SearchError(
      "UNSUPPORTED_QUALIFIER",
      `Qualifier ${typedKey} is not supported for ${surface} search.`,
      parsed.keySpan,
    );
  }

  const raw = parsed.value;
  const normalized = normalizeSearchKey(raw);
  switch (typedKey) {
    case "type":
      return clause(parsed, "type", enumValue(raw, ENTITY_TYPES, "type", parsed));
    case "team":
    case "project":
    case "server":
    case "tag":
    case "publisher":
    case "kind":
      return clause(parsed, typedKey, raw);
    case "status":
      return clause(parsed, "status", validateStatus(raw, surface, parsed));
    case "cached":
    case "verified":
    case "featured":
      if (normalized !== "true" && normalized !== "false") {
        throw invalidValue(typedKey, parsed);
      }
      return clause(parsed, typedKey, normalized === "true");
    case "effect":
      return clause(parsed, "effect", enumValue(raw, EFFECTS, "effect", parsed));
    case "transport":
      return clause(parsed, "transport", validateTransport(raw, surface, parsed));
    case "category":
      return clause(parsed, "category", enumValue(raw, CATEGORIES, "category", parsed));
    case "after":
    case "before":
      return clause(parsed, typedKey, parseDateBound(raw, parsed.valueSpan));
  }
}

function validateStatus(
  raw: string,
  surface: SearchSurface,
  parsed: ParsedQualifierClause,
): SearchStatus {
  const value = normalizeSearchKey(raw);
  const allowed =
    surface === "admin"
      ? ["enabled", "disabled", "active", "attention", "quiet", "archived", "deleted"]
      : ["enabled", "disabled", "active", "attention", "quiet", "archived"];
  if (!(allowed as readonly string[]).includes(value)) throw invalidValue("status", parsed);
  return value as SearchStatus;
}

function validateTransport(
  raw: string,
  surface: SearchSurface,
  parsed: ParsedQualifierClause,
): SearchTransport {
  const value = normalizeSearchKey(raw);
  const allowedBySurface: Record<SearchSurface, readonly SearchTransport[]> = {
    dashboard: ["http"],
    mcp: [],
    registry: ["http", "sse", "stdio"],
    templates: [],
    activity: [],
    admin: ["http", "sse", "stdio"],
    cli: ["stdio", "http-streamable"],
  };
  if (!(allowedBySurface[surface] as readonly string[]).includes(value)) {
    throw invalidValue("transport", parsed);
  }
  return value as SearchTransport;
}

function validateTypeApplicability(
  clauses: readonly ValidatedSearchClause[],
  context: SearchValidationContext,
  effectiveTypes: readonly SearchEntityType[],
): void {
  for (const clause of clauses) {
    if (clause.kind !== "qualifier" || !TYPE_REQUIRING_SINGLE_ENTITY.includes(clause.key)) continue;
    const required = compatibleTypes(clause, context.surface);
    const available = context.fixedType ? [context.fixedType] : effectiveTypes;
    if (available.length !== 1 || !required.includes(available[0] as SearchEntityType)) {
      throw new SearchError(
        "INCOMPATIBLE_TYPE",
        `Qualifier ${clause.key} needs one compatible result type; specify type:<kind> or use a fixed-type adapter.`,
        clause.span,
      );
    }
  }
}

function validateExplicitTypes(
  clauses: readonly Extract<ValidatedQualifierClause, { key: "type" }>[],
  context: SearchValidationContext,
  surfaceTypes: readonly SearchEntityType[],
): void {
  for (const clause of clauses) {
    if (!surfaceTypes.includes(clause.value)) {
      throw new SearchError(
        "INCOMPATIBLE_TYPE",
        `Search type ${clause.value} is not available on the ${context.surface} surface.`,
        clause.span,
      );
    }
    if (context.fixedType && clause.value !== context.fixedType) {
      throw new SearchError(
        "INCOMPATIBLE_TYPE",
        `Search type ${clause.value} is incompatible with the fixed ${context.fixedType} result type.`,
        clause.span,
      );
    }
  }
}

function validateReferenceApplicability(
  clauses: readonly ValidatedSearchClause[],
  context: SearchValidationContext,
  effectiveTypes: readonly SearchEntityType[],
): void {
  if (context.surface !== "admin") return;
  const referenceClause = clauses.find(
    (clause) =>
      clause.kind === "qualifier" &&
      (clause.key === "team" || clause.key === "project" || clause.key === "server"),
  );
  if (!referenceClause || referenceClause.kind !== "qualifier") return;
  const selectedTypes = context.fixedType ? [context.fixedType] : effectiveTypes;
  if (!selectedTypes.some((type) => type === "registry" || type === "template")) return;
  throw new SearchError(
    "INCOMPATIBLE_TYPE",
    `Qualifier ${referenceClause.key} does not apply when registry or template results are selected.`,
    referenceClause.span,
  );
}

function compatibleTypes(
  clause: ValidatedQualifierClause,
  surface: SearchSurface,
): readonly SearchEntityType[] {
  switch (clause.key) {
    case "status":
      switch (clause.value) {
        case "enabled":
        case "disabled":
          return ["tool"];
        case "attention":
        case "quiet":
          return ["project"];
        case "archived":
          return ["server"];
        case "deleted":
          return surface === "admin" ? ["project", "server", "tool", "registry", "template"] : [];
        case "active":
          return ["project", "server"];
      }
      return [];
    case "cached":
    case "effect":
      return ["tool"];
    case "transport":
      if (surface === "registry") return ["registry"];
      if (surface === "cli") return ["tool"];
      if (clause.value === "http") return ["server", "tool", "registry"];
      return ["registry"];
    case "tag":
      return ["registry", "template"];
    case "publisher":
    case "verified":
    case "featured":
      return ["registry"];
    case "category":
      return ["template"];
    case "kind":
    case "after":
    case "before":
      return ["activity"];
    case "type":
    case "team":
    case "project":
    case "server":
      return ENTITY_TYPES;
  }
}

function validateDateRange(clauses: readonly ValidatedSearchClause[]): void {
  const after = clauses.filter(
    (clause): clause is Extract<ValidatedQualifierClause, { key: "after" }> =>
      clause.kind === "qualifier" && clause.key === "after" && !clause.negated,
  );
  const before = clauses.filter(
    (clause): clause is Extract<ValidatedQualifierClause, { key: "before" }> =>
      clause.kind === "qualifier" && clause.key === "before" && !clause.negated,
  );
  if (after.length === 0 || before.length === 0) return;

  const earliestAfter = after.map(({ value }) => value).sort(compareDateBounds)[0];
  const latestBefore = before
    .map(({ value }) => value)
    .sort(compareDateBounds)
    .at(-1);
  if (earliestAfter && latestBefore && compareDateBounds(earliestAfter, latestBefore) >= 0) {
    const bounds = [...after, ...before];
    const span = {
      start: Math.min(...bounds.map(({ span: itemSpan }) => itemSpan.start)),
      end: Math.max(...bounds.map(({ span: itemSpan }) => itemSpan.end)),
    };
    throw new SearchError(
      "INVALID_DATE_RANGE",
      "The after bound must be earlier than the before bound.",
      span,
    );
  }
}

function normalizeKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function normalizeSearchKey(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}

function enumValue<T extends string>(
  raw: string,
  allowed: readonly T[],
  key: string,
  parsed: ParsedQualifierClause,
): T {
  const normalized = normalizeSearchKey(raw);
  const result = allowed.find((value) => value === normalized);
  if (!result) throw invalidValue(key, parsed);
  return result;
}

function invalidValue(key: string, parsed: ParsedQualifierClause): SearchError {
  return new SearchError(
    "INVALID_QUALIFIER_VALUE",
    `Invalid value for ${key}: ${JSON.stringify(parsed.value)}.`,
    parsed.valueSpan,
  );
}

function clause<K extends SearchQualifierKey>(
  parsed: ParsedQualifierClause,
  key: K,
  value: SearchQualifierValueMapFor<K>,
): Extract<ValidatedQualifierClause, { key: K }> {
  return {
    kind: "qualifier",
    key,
    value,
    quoted: parsed.quoted,
    negated: parsed.negated,
    span: parsed.span,
  } as Extract<ValidatedQualifierClause, { key: K }>;
}

type SearchQualifierValueMapFor<K extends SearchQualifierKey> =
  import("./types").SearchQualifierValueMap[K];

function groupQualifiers(clauses: readonly ValidatedSearchClause[]): SearchQualifierGroups {
  const groups: SearchQualifierGroups = {};
  for (const clause of clauses) {
    if (clause.kind !== "qualifier") continue;
    addToGroup(groups, clause);
  }
  return groups;
}

function addToGroup<K extends SearchQualifierKey>(
  groups: SearchQualifierGroups,
  clause: Extract<ValidatedQualifierClause, { key: K }>,
): void {
  const current = groups[clause.key] as
    | { include: readonly ValidatedQualifierClause[]; exclude: readonly ValidatedQualifierClause[] }
    | undefined;
  const include = [...(current?.include ?? [])];
  const exclude = [...(current?.exclude ?? [])];
  (clause.negated ? exclude : include).push(clause);
  groups[clause.key] = { include, exclude };
}

function canonicalize(clauses: readonly ValidatedSearchClause[]): string {
  const encoded = clauses.map((clause) => {
    if (clause.kind === "text") {
      return {
        kind: "text",
        value: clause.value.normalize("NFC").toLowerCase().normalize("NFC"),
        negated: clause.negated,
      };
    }
    return {
      kind: "qualifier",
      key: clause.key,
      value: canonicalValue(clause.key, clause.value),
      ...(isReferenceQualifier(clause.key) ? { quoted: clause.quoted } : {}),
      negated: clause.negated,
    };
  });
  encoded.sort((left, right) => compareCodePoints(JSON.stringify(left), JSON.stringify(right)));
  return JSON.stringify(encoded);
}

function canonicalValue(
  key: SearchQualifierKey,
  value: SearchQualifierValueMapFor<SearchQualifierKey>,
): unknown {
  if (key === "after" || key === "before") return (value as SearchDateBound).value;
  if (typeof value !== "string") return value;
  if (["type", "status", "effect", "transport", "category"].includes(key)) {
    return value.normalize("NFC").toLowerCase().normalize("NFC");
  }
  return value;
}

function isReferenceQualifier(key: SearchQualifierKey): key is "team" | "project" | "server" {
  return key === "team" || key === "project" || key === "server";
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
