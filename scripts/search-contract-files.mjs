export const SEARCH_CONTRACT_SOURCE_FILES = [
  "src/types.ts",
  "src/parser.ts",
  "src/validation.ts",
  "src/match.ts",
  "src/ranking.ts",
  "src/date.ts",
  "src/index.ts",
  "fixtures/semantic-corpus.json",
];

export function targetPathForSource(sourcePath) {
  if (sourcePath === "fixtures/semantic-corpus.json") {
    return "test/fixtures/search/semantic-corpus.json";
  }
  return `src/core/search/${sourcePath.slice("src/".length)}`;
}
