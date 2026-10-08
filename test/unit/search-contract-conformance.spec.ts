import corpus from "../fixtures/search/semantic-corpus.json";
import {
  matchesTextClauses,
  parseSearchQuery,
  rankToolCandidates,
  validateSearchQuery,
  type SearchSurface,
  type ToolRankingProfile,
  type ValidatedSearchQuery,
} from "../../src/core/search/index.js";
import { describe, expect, it } from "vitest";

function parseRankingProfile(value: string): ToolRankingProfile {
  if (value === "hosted" || value === "cli") return value;
  throw new Error(`Invalid ranking profile in semantic corpus: ${value}`);
}

function summarize(query: ValidatedSearchQuery) {
  const groups: Record<string, { include: unknown[]; exclude: unknown[] }> = {};
  for (const [key, group] of Object.entries(query.qualifiers)) {
    if (!group) continue;
    groups[key] = {
      include: group.include.map(({ value }) => summarizeValue(value)),
      exclude: group.exclude.map(({ value }) => summarizeValue(value)),
    };
  }
  return {
    requiredText: query.text.required.map(({ value }) => value),
    excludedText: query.text.excluded.map(({ value }) => value),
    effectiveTypes: query.effectiveTypes,
    groups,
    spans: query.clauses.map(({ span }) => [span.start, span.end]),
  };
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "value" in value) {
    return value.value;
  }
  return value;
}

describe("portable search source semantic corpus", () => {
  it.each(corpus.grammarCases)("parses and validates $name", (fixture) => {
    const query = validateSearchQuery(parseSearchQuery(fixture.query), {
      surface: fixture.surface as SearchSurface,
    });
    expect(summarize(query)).toEqual(fixture.expected);
  });

  it.each(corpus.literalCases)("matches literal Unicode text: $query", (fixture) => {
    const query = validateSearchQuery(parseSearchQuery(fixture.query), { surface: "dashboard" });
    expect(matchesTextClauses(query.text, fixture.fields)).toBe(fixture.matches);
  });

  it.each(corpus.rankingCases)("preserves the $profile task ranking profile", (fixture) => {
    const ranked = rankToolCandidates(fixture.task, fixture.candidates, {
      profile: parseRankingProfile(fixture.profile),
    });
    expect(ranked.map(({ identity, score }) => ({ identity, score }))).toEqual(fixture.expected);
  });
});
