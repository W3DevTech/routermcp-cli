// Generated from https://github.com/W3DevTech/routermcp.git@5fb9136c81e4a1c683a0bbd616e5f551cbe71849:packages/search/src/ranking.ts. Do not edit.
import { normalizeSearchText } from "./match";
import type {
  RankedToolCandidate,
  SearchEntityType,
  ToolRankingCandidate,
  ToolRankingOptions,
  ValidatedSearchQuery,
} from "./types";

export interface ExplicitSearchCandidate {
  id: string;
  kind: SearchEntityType;
  identifier?: string | null;
  label: string;
  description?: string | null;
}

export interface ExplicitSearchOrder {
  /** 0 exact identifier, 1 exact name, 2 name prefix, 3 name substring, 4 description, 5 other. */
  matchRank: 0 | 1 | 2 | 3 | 4 | 5;
  normalizedLabel: string;
  kind: SearchEntityType;
  id: string;
}

/** Rank a result after literal query matching has selected it. */
export function rankExplicitSearchResult(
  query: ValidatedSearchQuery,
  candidate: ExplicitSearchCandidate,
): ExplicitSearchOrder {
  const searchText = normalizeSearchText(query.text.required.map(({ value }) => value).join(" "));
  const identifier = normalizeSearchText(candidate.identifier ?? "");
  const label = normalizeSearchText(candidate.label);
  const description = normalizeSearchText(candidate.description ?? "");
  let matchRank: ExplicitSearchOrder["matchRank"] = 5;

  if (searchText.length > 0) {
    if (identifier === searchText) matchRank = 0;
    else if (label === searchText) matchRank = 1;
    else if (label.startsWith(searchText)) matchRank = 2;
    else if (label.includes(searchText)) matchRank = 3;
    else if (description.includes(searchText)) matchRank = 4;
  }

  return { matchRank, normalizedLabel: label, kind: candidate.kind, id: candidate.id };
}

/** Compare pre-ranked explicit results by relevance, normalized label, kind, and stable ID. */
export function compareExplicitSearchOrder(
  left: ExplicitSearchOrder,
  right: ExplicitSearchOrder,
): number {
  return (
    left.matchRank - right.matchRank ||
    compareCodePoints(left.normalizedLabel, right.normalizedLabel) ||
    compareCodePoints(left.kind, right.kind) ||
    compareCodePoints(left.id, right.id)
  );
}

export function compareExplicitSearchResults(
  query: ValidatedSearchQuery,
  left: ExplicitSearchCandidate,
  right: ExplicitSearchCandidate,
): number {
  return compareExplicitSearchOrder(
    rankExplicitSearchResult(query, left),
    rankExplicitSearchResult(query, right),
  );
}

/** Preserve hosted/CLI task score meaning while adding Unicode tokens and deterministic ties. */
export function rankToolCandidates<T extends ToolRankingCandidate>(
  task: string,
  candidates: readonly T[],
  options: ToolRankingOptions,
): RankedToolCandidate[] {
  const queryTokens = tokenizeForProfile(task, options.profile);
  if (queryTokens.length === 0) return [];

  const minScore = options.minScore ?? 0;
  if (!Number.isFinite(minScore) || minScore < 0) {
    throw new RangeError("minScore must be a finite nonnegative number.");
  }

  const enableFuzzy = options.profile === "cli" && (options.enableFuzzy ?? true);
  return candidates
    .map((candidate) => ({
      identity: candidate.identity,
      name: candidate.name,
      description: candidate.description ?? "",
      score: scoreCandidate(queryTokens, candidate, options.profile, enableFuzzy),
    }))
    .filter((candidate) => candidate.score > 0 && candidate.score >= minScore)
    .sort(compareRankedTools);
}

/** The CLI legacy task-token normalization, extended to Unicode letters and numbers. */
export function tokenizeRankingText(value: string): string[] {
  const separated = value
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/_/gu, " ");
  return normalizeSearchText(separated).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenizeForProfile(value: string, profile: ToolRankingOptions["profile"]): string[] {
  return profile === "hosted" ? tokenizeHostedTaskText(value) : tokenizeRankingText(value);
}

/** The hosted legacy profile splits on non-letters and digits but preserves camel-case words. */
function tokenizeHostedTaskText(value: string): string[] {
  return normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function compareRankedTools(left: RankedToolCandidate, right: RankedToolCandidate): number {
  return (
    right.score - left.score ||
    compareCodePoints(left.identity, right.identity) ||
    compareCodePoints(left.name, right.name) ||
    compareCodePoints(left.description ?? "", right.description ?? "")
  );
}

function scoreCandidate(
  queryTokens: readonly string[],
  candidate: ToolRankingCandidate,
  profile: ToolRankingOptions["profile"],
  enableFuzzy: boolean,
): number {
  const tokenize = (value: string) => tokenizeForProfile(value, profile);
  const nameTokens = tokenize(candidate.name);
  const descriptionTokens = tokenize(candidate.description ?? "");
  const documentTokens = [...nameTokens, ...descriptionTokens];
  const documentSet = new Set(documentTokens);
  const exactMatches = queryTokens.reduce(
    (score, token) => score + Number(documentSet.has(token)),
    0,
  );
  const phraseBonus = documentTokens.join(" ").includes(queryTokens.join(" ")) ? 0.5 : 0;

  if (profile === "hosted") return exactMatches + phraseBonus;

  const fuzzyMatches = enableFuzzy
    ? queryTokens.reduce(
        (score, queryToken) =>
          score +
          Number(documentTokens.some((token) => levenshteinDistanceAtMostTwo(queryToken, token))),
        0,
      )
    : 0;
  const nameSet = new Set(nameTokens);
  const nameMatches = queryTokens.reduce((score, token) => score + Number(nameSet.has(token)), 0);
  return exactMatches + fuzzyMatches * 0.5 + phraseBonus + nameMatches * 0.5;
}

/** Levenshtein distance bounded to 2, matching the CLI profile's default fuzzy rule. */
export function levenshteinDistanceAtMostTwo(left: string, right: string): boolean {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > 2) return false;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length) <= 2;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column++) {
      const substitution = (a[row - 1] === b[column - 1] ? 0 : 1) + (previous[column - 1] ?? 0);
      const insertion = (current[column - 1] ?? 0) + 1;
      const deletion = (previous[column] ?? 0) + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current[column] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > 2) return false;
    previous = current;
  }
  return (previous[b.length] ?? 3) <= 2;
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
