import { describe, expect, it } from "vitest";
import {
  type RankingOptions,
  type ToolRankingInput,
  levenshteinDistance,
  rankTools,
  tokenize,
} from "../../../../src/core/toolsearch/ranking.js";

describe("tokenize", () => {
  it("should split camelCase words", () => {
    expect(tokenize("getUserName")).toEqual(["get", "user", "name"]);
  });

  it("should split snake_case words", () => {
    expect(tokenize("get_user_name")).toEqual(["get", "user", "name"]);
  });

  it("should convert to lowercase", () => {
    expect(tokenize("GetUserName")).toEqual(["get", "user", "name"]);
  });

  it("should remove non-alphanumeric characters", () => {
    expect(tokenize("get-user@name!")).toEqual(["get", "user", "name"]);
  });

  it("should filter empty strings", () => {
    expect(tokenize("  hello   world  ")).toEqual(["hello", "world"]);
  });

  it("should handle mixed formats", () => {
    expect(tokenize("getUserName_v2")).toEqual(["get", "user", "name", "v2"]);
  });
});

describe("levenshteinDistance", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("should return length for one empty string", () => {
    expect(levenshteinDistance("", "hello")).toBe(5);
    expect(levenshteinDistance("hello", "")).toBe(5);
  });

  it("should calculate single character substitution", () => {
    expect(levenshteinDistance("hello", "hallo")).toBe(1);
  });

  it("should calculate single character insertion", () => {
    expect(levenshteinDistance("hello", "helllo")).toBe(1);
  });

  it("should calculate single character deletion", () => {
    expect(levenshteinDistance("hello", "helo")).toBe(1);
  });

  it("should handle typos (distance ≤ 2)", () => {
    expect(levenshteinDistance("translate", "translat")).toBe(1); // Delete 'e'
    expect(levenshteinDistance("translate", "translte")).toBe(1); // Insert 'a'
    expect(levenshteinDistance("translate", "translxte")).toBe(1); // Substitute 'a' with 'x'
    expect(levenshteinDistance("translate", "translt")).toBe(2); // Delete 'a' and 'e'
  });

  it("should calculate distance for completely different strings", () => {
    expect(levenshteinDistance("cat", "dog")).toBe(3);
  });
});

describe("rankTools", () => {
  const options: RankingOptions = {
    maxResults: 10,
    minScore: 0,
    enableFuzzy: true,
  };

  const tools: ToolRankingInput[] = [
    { name: "translate", description: "Translate text between languages" },
    { name: "search", description: "Search the web for information" },
    { name: "getWeather", description: "Get current weather for a location" },
    { name: "sendEmail", description: "Send an email message" },
    { name: "calculateMath", description: "Perform mathematical calculations" },
  ];

  it("should rank exact matches highest", () => {
    const results = rankTools("translate", tools, options);
    expect(results[0].name).toBe("translate");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("should rank by relevance to description", () => {
    const results = rankTools("weather forecast", tools, options);
    expect(results[0].name).toBe("getWeather");
  });

  it("should handle fuzzy matching for typos", () => {
    const results = rankTools("translat", tools, options);
    expect(results[0].name).toBe("translate");
  });

  it("should respect maxResults limit", () => {
    const limitedOptions: RankingOptions = {
      ...options,
      maxResults: 3,
    };
    const results = rankTools("search", tools, limitedOptions);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should respect minScore filter", () => {
    const filteredOptions: RankingOptions = {
      ...options,
      minScore: 2.0,
    };
    const results = rankTools("irrelevant query xyz", tools, filteredOptions);
    expect(results.every((r) => r.score >= 2.0)).toBe(true);
  });

  it("should give name matches higher scores", () => {
    const results = rankTools("translate", tools, options);
    const translateResult = results.find((r) => r.name === "translate");
    expect(translateResult).toBeDefined();
    expect(translateResult!.score).toBeGreaterThan(1);
  });

  it("should apply phrase match bonus", () => {
    const toolsWithPhrase: ToolRankingInput[] = [
      { name: "tool1", description: "search the web" },
      { name: "tool2", description: "web for search the" },
    ];
    const results = rankTools("search the web", toolsWithPhrase, options);
    expect(results[0].name).toBe("tool1"); // Exact phrase match
  });

  it("should handle empty query", () => {
    const results = rankTools("", tools, options);
    expect(results.length).toBe(0);
  });

  it("should handle empty tools list", () => {
    const results = rankTools("test query", [], options);
    expect(results.length).toBe(0);
  });

  it("should sort results by score descending", () => {
    const results = rankTools("translate language", tools, options);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("should handle camelCase tool names", () => {
    const camelTools: ToolRankingInput[] = [
      { name: "getUserInfo", description: "Get user information" },
      { name: "createUserAccount", description: "Create a new user" },
    ];
    const results = rankTools("get user", camelTools, options);
    expect(results[0].name).toBe("getUserInfo");
  });

  it("should disable fuzzy matching when enableFuzzy is false", () => {
    const noFuzzyOptions: RankingOptions = {
      ...options,
      enableFuzzy: false,
    };
    const results = rankTools("translat", tools, noFuzzyOptions);
    // Without fuzzy matching, typo "translat" shouldn't match "translate" as well
    const translateScore = results.find((r) => r.name === "translate")?.score || 0;

    const fuzzyResults = rankTools("translat", tools, options);
    const fuzzyScore = fuzzyResults.find((r) => r.name === "translate")?.score || 0;

    expect(fuzzyScore).toBeGreaterThan(translateScore);
  });

  it("should handle multiple token matches", () => {
    const results = rankTools("translate text language", tools, options);
    expect(results[0].name).toBe("translate");
    expect(results[0].score).toBeGreaterThan(2); // Multiple matches
  });

  it("should return empty array when all scores below minScore", () => {
    const highThreshold: RankingOptions = {
      ...options,
      minScore: 100,
    };
    const results = rankTools("test", tools, highThreshold);
    expect(results.length).toBe(0);
  });
});
