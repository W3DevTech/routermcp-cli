// Maintainer-only: `search:sync` regenerates src/core/search/ from the private
// RouterMCP monorepo and requires access to it. `search:verify` and the tests
// run without that access.
import { execFileSync } from "node:child_process";

export const SEARCH_CONTRACT_SOURCE_REPOSITORY = "https://github.com/W3DevTech/routermcp.git";
export const SEARCH_CONTRACT_SOURCE_PACKAGE = "packages/search";

const ALLOWED_SOURCE_REMOTES = new Set([
  "github.com/w3devtech/routermcp",
  // RouterMCP's former owner URL redirects to the canonical repository.
  "github.com/w3mirror/routermcp",
]);

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function normalizeRemote(remoteUrl) {
  const httpsUrl = remoteUrl
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");

  try {
    const parsed = new URL(httpsUrl);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const repositoryPath = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
    return `${parsed.hostname.toLowerCase()}${repositoryPath}`.toLowerCase();
  } catch {
    return null;
  }
}

export function validateSourceRepository(repository) {
  let originUrl;
  try {
    originUrl = git(repository, "remote", "get-url", "origin");
  } catch {
    throw new Error("The search contract source must have an origin remote for W3DevTech/routermcp");
  }

  const normalized = normalizeRemote(originUrl);
  if (!normalized || !ALLOWED_SOURCE_REMOTES.has(normalized)) {
    throw new Error("The search contract source origin must resolve to W3DevTech/routermcp");
  }
}

export function refreshPublishedSourceRef(repository, publishedRef) {
  if (!publishedRef.startsWith("refs/heads/")) {
    throw new Error("--published-ref must name a remote branch as refs/heads/<branch>");
  }
  try {
    execFileSync("git", ["-C", repository, "check-ref-format", publishedRef], {
      encoding: "utf8",
      stdio: "ignore",
    });
  } catch {
    throw new Error("--published-ref is not a valid remote branch ref");
  }

  const branch = publishedRef.slice("refs/heads/".length);
  const trackingRef = `refs/remotes/origin/${branch}`;
  try {
    execFileSync(
      "git",
      ["-C", repository, "fetch", "--no-tags", "origin", `+${publishedRef}:${trackingRef}`],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error(`Could not refresh published source ref ${publishedRef} from canonical origin`);
  }

  return git(repository, "rev-parse", `${trackingRef}^{commit}`);
}

export function verifySourceCommitOnPublishedRef(repository, sourceCommit, publishedHead, publishedRef) {
  try {
    execFileSync(
      "git",
      ["-C", repository, "merge-base", "--is-ancestor", sourceCommit, publishedHead],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error(`The source commit is not contained in the refreshed published ref ${publishedRef}`);
  }
}

export function verifyMergedProvenance(repository, sourceCommit, mergedParent) {
  if (!/^[0-9a-f]{40}$/iu.test(mergedParent)) {
    throw new Error("--merged-parent must be a full 40-character commit SHA");
  }

  const resolvedParent = git(repository, "rev-parse", `${mergedParent}^{commit}`);
  try {
    execFileSync(
      "git",
      ["-C", repository, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error("Could not refresh canonical origin/main for landing provenance verification");
  }

  const mainHead = git(repository, "rev-parse", "refs/remotes/origin/main^{commit}");
  try {
    execFileSync(
      "git",
      ["-C", repository, "merge-base", "--is-ancestor", sourceCommit, mainHead],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error("The source commit is not contained in refreshed canonical origin/main");
  }

  try {
    execFileSync(
      "git",
      ["-C", repository, "merge-base", "--is-ancestor", sourceCommit, resolvedParent],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error("The source commit is not an ancestor of --merged-parent");
  }

  try {
    execFileSync(
      "git",
      ["-C", repository, "merge-base", "--is-ancestor", resolvedParent, mainHead],
      { encoding: "utf8", stdio: "ignore" },
    );
  } catch {
    throw new Error("--merged-parent is not contained in refreshed canonical origin/main");
  }

  return resolvedParent;
}
