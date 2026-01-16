export interface ToolRankingInput {
  name: string;
  description: string;
}

export interface RankedTool {
  name: string;
  score: number;
}

export interface RankingOptions {
  maxResults: number;
  minScore: number;
  enableFuzzy: boolean;
}

/**
 * Ranks tools based on relevance to a task description.
 * Uses token-based matching with fuzzy matching support.
 *
 * @param task - Natural language description of the task
 * @param tools - Array of tools to rank
 * @param options - Ranking configuration options
 * @returns Sorted array of tools with scores, limited by maxResults and minScore
 */
export function rankTools(
  task: string,
  tools: ToolRankingInput[],
  options: RankingOptions,
): RankedTool[] {
  const queryTokens = tokenize(task);

  // Return empty array if query is empty
  if (queryTokens.length === 0) {
    return [];
  }

  const scored = tools.map((tool) => {
    const score = calculateRelevanceScore(queryTokens, tool, options.enableFuzzy);
    return { name: tool.name, score };
  });

  const filtered = scored.filter((item) => item.score >= options.minScore);
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, options.maxResults);
}

/**
 * Calculates relevance score for a tool based on query tokens.
 * Scoring components:
 * - Exact token matches: 1.0 per match
 * - Fuzzy token matches (Levenshtein ≤2): 0.5 per match
 * - Phrase match bonus: +0.5 if all query tokens appear consecutively
 * - Name prominence: +0.5 per exact match in tool name
 */
function calculateRelevanceScore(
  queryTokens: string[],
  tool: ToolRankingInput,
  enableFuzzy: boolean,
): number {
  const nameTokens = tokenize(tool.name);
  const descTokens = tokenize(tool.description);
  const allToolTokens = [...nameTokens, ...descTokens];

  // Exact token matches
  const exactMatches = countExactMatches(queryTokens, allToolTokens);

  // Fuzzy matches (Levenshtein distance ≤ 2)
  const fuzzyMatches = enableFuzzy ? countFuzzyMatches(queryTokens, allToolTokens) : 0;

  // Phrase match bonus
  const phraseBonus = hasPhraseMatch(queryTokens, allToolTokens) ? 0.5 : 0;

  // Name prominence bonus
  const nameMatches = countExactMatches(queryTokens, nameTokens);
  const nameBonus = nameMatches * 0.5;

  return exactMatches * 1.0 + fuzzyMatches * 0.5 + phraseBonus + nameBonus;
}

/**
 * Tokenizes text into searchable tokens.
 * - Splits camelCase and snake_case
 * - Converts to lowercase
 * - Removes non-alphanumeric characters
 * - Filters empty strings
 */
export function tokenize(text: string): string[] {
  return (
    text
      // Split camelCase (must happen before lowercasing)
      .replace(/([a-z])([A-Z])/g, "$1 $2") // lowercase to uppercase
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") // uppercase to uppercase+lowercase
      .replace(/_/g, " ") // Replace underscores with spaces
      .toLowerCase() // Convert to lowercase after splitting
      .replace(/[^a-z0-9\s]/g, " ") // Remove non-alphanumeric
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Counts exact token matches between query and document.
 */
function countExactMatches(queryTokens: string[], docTokens: string[]): number {
  const docSet = new Set(docTokens);
  let count = 0;
  for (const token of queryTokens) {
    if (docSet.has(token)) count++;
  }
  return count;
}

/**
 * Counts fuzzy token matches using Levenshtein distance.
 * A match is counted if distance ≤ 2.
 */
function countFuzzyMatches(queryTokens: string[], docTokens: string[]): number {
  let count = 0;
  const MAX_DISTANCE = 2;

  for (const qToken of queryTokens) {
    for (const dToken of docTokens) {
      if (levenshteinDistance(qToken, dToken) <= MAX_DISTANCE) {
        count++;
        break; // Count each query token at most once
      }
    }
  }
  return count;
}

/**
 * Checks if all query tokens appear consecutively in document.
 */
function hasPhraseMatch(queryTokens: string[], docTokens: string[]): boolean {
  const queryPhrase = queryTokens.join(" ");
  const docPhrase = docTokens.join(" ");
  return docPhrase.includes(queryPhrase);
}

/**
 * Calculates Levenshtein distance between two strings.
 * Levenshtein distance is the minimum number of single-character edits
 * (insertions, deletions, or substitutions) required to change one string into another.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Number of edits required
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  // Initialize first column
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  // Initialize first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]; // No edit needed
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // Substitution
          matrix[i][j - 1] + 1, // Insertion
          matrix[i - 1][j] + 1, // Deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
