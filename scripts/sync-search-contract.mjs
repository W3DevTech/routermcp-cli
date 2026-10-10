import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_CONTRACT_SOURCE_FILES, targetPathForSource } from "./search-contract-files.mjs";
import {
  refreshPublishedSourceRef,
  SEARCH_CONTRACT_SOURCE_PACKAGE,
  SEARCH_CONTRACT_SOURCE_REPOSITORY,
  validateSourceRepository,
  verifyMergedProvenance,
  verifySourceCommitOnPublishedRef,
} from "./search-contract-source.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function parseArgs(args) {
  const options = {
    sourceRepo: undefined,
    commit: undefined,
    publishedRef: undefined,
    mergedParent: undefined,
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--source-repo") options.sourceRepo = args[++index];
    else if (flag === "--commit") options.commit = args[++index];
    else if (flag === "--published-ref") options.publishedRef = args[++index];
    else if (flag === "--merged-parent") options.mergedParent = args[++index];
    else if (flag === "--help") return { help: true };
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.sourceRepo || !options.commit || !options.publishedRef) {
    throw new Error(
      "Usage: node scripts/sync-search-contract.mjs --source-repo <repo> --commit <40-char-sha> --published-ref refs/heads/<branch> [--merged-parent <sha>]",
    );
  }
  return options;
}

function git(sourceRepo, ...args) {
  return execFileSync("git", ["-C", sourceRepo, ...args], { encoding: "utf8" }).trim();
}

function readCommittedFile(sourceRepo, commit, filePath) {
  return execFileSync("git", ["-C", sourceRepo, "show", `${commit}:${filePath}`]);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSourceCommit(sourceRepo, commit) {
  if (!SOURCE_COMMIT_PATTERN.test(commit)) {
    throw new Error("--commit must be a full 40-character immutable commit SHA");
  }
  const resolved = git(sourceRepo, "rev-parse", `${commit}^{commit}`);
  if (resolved.toLowerCase() !== commit.toLowerCase()) {
    throw new Error("The requested source SHA did not resolve to the same immutable commit");
  }
  return resolved.toLowerCase();
}

function generatedHeader(commit, sourceFile) {
  return `// Generated from ${SEARCH_CONTRACT_SOURCE_REPOSITORY}@${commit}:${SEARCH_CONTRACT_SOURCE_PACKAGE}/${sourceFile}. Do not edit.\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/sync-search-contract.mjs --source-repo <repo> --commit <40-char-sha> --published-ref refs/heads/<branch> [--merged-parent <sha>]\n",
    );
    return;
  }

  const sourceRepo = path.resolve(options.sourceRepo);
  validateSourceRepository(sourceRepo);
  const sourceCommit = validateSourceCommit(sourceRepo, options.commit);
  const publishedHead = refreshPublishedSourceRef(sourceRepo, options.publishedRef).toLowerCase();
  verifySourceCommitOnPublishedRef(sourceRepo, sourceCommit, publishedHead, options.publishedRef);
  const mergedParent = options.mergedParent
    ? verifyMergedProvenance(sourceRepo, sourceCommit, options.mergedParent).toLowerCase()
    : null;

  const entries = [];
  for (const sourceFile of SEARCH_CONTRACT_SOURCE_FILES) {
    const sourcePath = path.posix.join(SEARCH_CONTRACT_SOURCE_PACKAGE, sourceFile);
    const sourceBytes = readCommittedFile(sourceRepo, sourceCommit, sourcePath);
    const targetPath = targetPathForSource(sourceFile);
    const absoluteTarget = path.resolve(repositoryRoot, targetPath);
    if (!absoluteTarget.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error(`Invalid generated target path: ${targetPath}`);
    }
    const bytes = sourceFile.endsWith(".ts")
      ? Buffer.concat([Buffer.from(generatedHeader(sourceCommit, sourceFile)), sourceBytes])
      : sourceBytes;
    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    await writeFile(absoluteTarget, bytes);
    entries.push({
      sourcePath,
      targetPath,
      sourceSha256: digest(sourceBytes),
      sha256: digest(bytes),
    });
  }

  const manifest = {
    manifestVersion: 2,
    sourceRepository: SEARCH_CONTRACT_SOURCE_REPOSITORY,
    sourceCommit,
    sourcePackage: SEARCH_CONTRACT_SOURCE_PACKAGE,
    contractVersion: 1,
    sourceState: mergedParent ? "merged-provenance-verified" : "prepared-published-head",
    publishedRef: options.publishedRef,
    publishedHead,
    mergedParent,
    files: entries.sort((left, right) => left.targetPath.localeCompare(right.targetPath)),
  };
  await writeFile(
    path.join(repositoryRoot, "src/core/search/source-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`Synchronized ${entries.length} files from ${sourceCommit}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
