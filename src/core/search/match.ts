// Generated from https://github.com/W3DevTech/routermcp.git@5fb9136c81e4a1c683a0bbd616e5f551cbe71849:packages/search/src/match.ts. Do not edit.
import type {
  SearchDateBound,
  SearchFieldValue,
  SearchMatchAccessors,
  SearchQualifierGroup,
  SearchQualifierKey,
  SearchQualifierValueMap,
  ValidatedSearchQuery,
} from "./types";
import { compareDateBounds, parseDateBound } from "./validation";

/** NFC plus locale-independent Unicode lowercasing; accents are preserved. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}

/** Escape input before binding it inside a SQL LIKE pattern; use `ESCAPE '\\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

/** Match literal text clauses against any declared text field. */
export function matchesTextClauses(
  text: ValidatedSearchQuery["text"],
  fields: readonly (string | null | undefined)[],
): boolean {
  const normalizedFields = fields
    .filter((field): field is string => typeof field === "string")
    .map(normalizeSearchText);
  if (
    text.required.some(
      (clause) =>
        !normalizedFields.some((field) => field.includes(normalizeSearchText(clause.value))),
    )
  ) {
    return false;
  }
  return !text.excluded.some((clause) =>
    normalizedFields.some((field) => field.includes(normalizeSearchText(clause.value))),
  );
}

/** Apply the canonical query to a portable record using explicit field accessors. */
export function matchesSearchQuery<T>(
  query: ValidatedSearchQuery,
  candidate: T,
  accessors: SearchMatchAccessors<T>,
): boolean {
  if (query.effectiveTypes.length === 0) return false;
  const rawType = accessors.qualifierValue(candidate, "type");
  if (!matchesAnyType(rawType, query.effectiveTypes)) return false;
  if (!matchesTextClauses(query.text, accessors.textFields(candidate))) return false;

  for (const key of Object.keys(query.qualifiers) as SearchQualifierKey[]) {
    const group = query.qualifiers[key];
    if (!group) continue;
    const rawValue = accessors.qualifierValue(candidate, key);
    if (!matchesQualifierGroup(key, group, rawValue, accessors.equalsQualifier)) return false;
  }
  return true;
}

/** Positive values for one key are ORed; every negative value independently excludes. */
export function matchesQualifierGroup(
  key: SearchQualifierKey,
  group: SearchQualifierGroup,
  candidateValue: SearchFieldValue,
  equals?: SearchMatchAccessors<unknown>["equalsQualifier"],
): boolean {
  if (
    group.include.length > 0 &&
    !group.include.some((clause) =>
      matchesQualifierValue(key, candidateValue, clause.value, equals),
    )
  ) {
    return false;
  }
  return !group.exclude.some((clause) =>
    matchesQualifierValue(key, candidateValue, clause.value, equals),
  );
}

/** Match one value while preserving nullable-field negation and array-membership semantics. */
export function matchesQualifierValue(
  key: SearchQualifierKey,
  candidateValue: SearchFieldValue,
  queryValue: SearchQualifierValueMap[SearchQualifierKey],
  equals?: SearchMatchAccessors<unknown>["equalsQualifier"],
): boolean {
  if (key === "cached" && (candidateValue === null || candidateValue === undefined)) {
    return queryValue === false;
  }
  if (candidateValue === null || candidateValue === undefined) return false;

  const values = Array.isArray(candidateValue) ? candidateValue : [candidateValue];
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    if (equals) {
      return equals(key, value, queryValue);
    }
    return defaultQualifierEquality(key, value, queryValue);
  });
}

function defaultQualifierEquality(
  key: SearchQualifierKey,
  candidateValue: string | number | boolean | Date,
  queryValue: SearchQualifierValueMap[SearchQualifierKey],
): boolean {
  if (key === "after" || key === "before") {
    const bound = queryValue as SearchDateBound;
    const candidateBound = asDateBound(candidateValue);
    if (!candidateBound) return false;
    const comparison = compareDateBounds(candidateBound, bound);
    return key === "after" ? comparison >= 0 : comparison < 0;
  }

  if (key === "cached" || key === "verified" || key === "featured") {
    const booleanValue =
      typeof candidateValue === "boolean"
        ? candidateValue
        : typeof candidateValue === "string" && /^(?:true|false)$/iu.test(candidateValue)
          ? candidateValue.toLowerCase() === "true"
          : null;
    return booleanValue !== null && booleanValue === queryValue;
  }

  if (typeof candidateValue === "boolean" || typeof queryValue === "boolean") {
    return candidateValue === queryValue;
  }
  if (typeof candidateValue === "number" || typeof queryValue === "number") {
    return candidateValue === queryValue;
  }
  if (candidateValue instanceof Date) return false;
  if (typeof candidateValue !== "string" || typeof queryValue !== "string") return false;

  switch (key) {
    case "type":
    case "status":
    case "effect":
    case "transport":
    case "category":
      return normalizeSearchText(candidateValue) === normalizeSearchText(queryValue);
    case "tag":
    case "publisher":
    case "kind":
    case "team":
    case "project":
    case "server":
      return candidateValue === queryValue;
  }
}

function matchesAnyType(
  candidateType: SearchFieldValue,
  effectiveTypes: readonly string[],
): boolean {
  if (typeof candidateType !== "string") return false;
  const normalized = normalizeSearchText(candidateType);
  return effectiveTypes.some((type) => normalizeSearchText(type) === normalized);
}

function asDateBound(value: string | number | boolean | Date): SearchDateBound | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const epochSeconds = Math.floor(value / 1_000);
    const nanosecond = Math.floor((value - epochSeconds * 1_000) * 1_000_000);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      input: String(value),
      value: date.toISOString(),
      kind: "timestamp",
      epochSeconds,
      nanosecond,
    };
  }
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) return null;
    return asDateBound(milliseconds);
  }
  if (typeof value !== "string") return null;
  try {
    return parseDateBound(value);
  } catch {
    return null;
  }
}
