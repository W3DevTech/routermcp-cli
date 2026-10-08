import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_CONTRACT_SOURCE_FILES, targetPathForSource } from "./search-contract-files.mjs";
import {
  SEARCH_CONTRACT_SOURCE_PACKAGE,
  SEARCH_CONTRACT_SOURCE_REPOSITORY,
  validateSourceRepository,
  verifyMergedProvenance,
} from "./search-contract-source.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "src/core/search/source-manifest.json";
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function parseArgs(args) {
  const options = { sourceRepo: undefined, mergedParent: undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--source-repo") options.sourceRepo = args[++index];
    else if (flag === "--merged-parent") options.mergedParent = args[++index];
    else if (flag === "--help") return { help: true };
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCommittedFile(repository, commit, filePath) {
  return execFileSync("git", ["-C", repository, "show", `${commit}:${filePath}`]);
}

function generatedHeader(sourceCommit, sourcePath) {
  return `// Generated from ${SEARCH_CONTRACT_SOURCE_REPOSITORY}@${sourceCommit}:${SEARCH_CONTRACT_SOURCE_PACKAGE}/${sourcePath}. Do not edit.\n`;
}

async function listFiles(directory, relativeTo) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, relativeTo)));
    else if (entry.isFile()) files.push(path.relative(relativeTo, absolute).split(path.sep).join("/"));
    else throw new Error(`Unexpected non-file in generated search source: ${absolute}`);
  }
  return files;
}

function expectedEntries() {
  return SEARCH_CONTRACT_SOURCE_FILES.map((sourceFile) => ({
    sourcePath: path.posix.join(SEARCH_CONTRACT_SOURCE_PACKAGE, sourceFile),
    targetPath: targetPathForSource(sourceFile),
  })).sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

function validateManifest(manifest) {
  if (
    manifest.manifestVersion !== 2 ||
    manifest.sourceRepository !== SEARCH_CONTRACT_SOURCE_REPOSITORY ||
    manifest.sourcePackage !== SEARCH_CONTRACT_SOURCE_PACKAGE ||
    !SOURCE_COMMIT_PATTERN.test(manifest.sourceCommit) ||
    manifest.contractVersion !== 1 ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Generated search manifest has invalid provenance or contract metadata");
  }

  if (
    typeof manifest.publishedRef !== "string" ||
    !manifest.publishedRef.startsWith("refs/heads/") ||
    !SOURCE_COMMIT_PATTERN.test(manifest.publishedHead)
  ) {
    throw new Error("Generated search manifest has invalid published-ref metadata");
  }

  if (manifest.sourceState === "prepared-published-head") {
    if (manifest.mergedParent !== null) {
      throw new Error("Prepared search source cannot claim merged provenance");
    }
  } else if (manifest.sourceState === "merged-provenance-verified") {
    if (!SOURCE_COMMIT_PATTERN.test(manifest.mergedParent)) {
      throw new Error("Merged search source must record its verified merged parent SHA");
    }
  } else {
    throw new Error("Generated search manifest has an unknown source state");
  }

  const expected = expectedEntries();
  if (manifest.files.length !== expected.length) {
    throw new Error("Generated search manifest does not contain the complete portable contract");
  }
  for (const [index, entry] of manifest.files.entries()) {
    const expectedEntry = expected[index];
    if (
      !expectedEntry ||
      entry.sourcePath !== expectedEntry.sourcePath ||
      entry.targetPath !== expectedEntry.targetPath ||
      !DIGEST_PATTERN.test(entry.sourceSha256) ||
      !DIGEST_PATTERN.test(entry.sha256)
    ) {
      throw new Error("Generated search manifest contains an invalid or incomplete file record");
    }
  }
}

function validatePortableImports(source, entry, generatedTypeScriptFiles) {
  const specifiers = [];
  for (const match of source.matchAll(
    /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\)|\bimport\s*["']([^"']+)["']/gu,
  )) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }

  for (const specifier of specifiers) {
    if (!specifier?.startsWith(".")) {
      throw new Error(`Generated search source has a non-relative import: ${entry.targetPath}`);
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.targetPath), specifier));
    const candidates = path.posix.extname(resolved)
      ? [resolved]
      : [`${resolved}.ts`, `${resolved}.json`, `${resolved}/index.ts`];
    if (!candidates.some((candidate) => generatedTypeScriptFiles.has(candidate))) {
      throw new Error(`Generated search source imports an untracked file: ${entry.targetPath}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/verify-search-contract.mjs [--source-repo <repo> --merged-parent <sha>]\n",
    );
    return;
  }
  if (Boolean(options.sourceRepo) !== Boolean(options.mergedParent)) {
    throw new Error("Provide both --source-repo and --merged-parent for landing provenance verification");
  }

  const absoluteManifestPath = path.join(repositoryRoot, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read generated search manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateManifest(manifest);

  const generatedTypeScriptFiles = new Set(
    manifest.files.filter((entry) => entry.targetPath.endsWith(".ts")).map((entry) => entry.targetPath),
  );
  const generatedFiles = new Map();
  const expectedFiles = new Set([manifestPath]);
  for (const entry of manifest.files) {
    const targetPath = path.resolve(repositoryRoot, entry.targetPath);
    if (!targetPath.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error(`Generated search target escapes repository: ${entry.targetPath}`);
    }
    expectedFiles.add(entry.targetPath);
    const bytes = await readFile(targetPath);
    if (digest(bytes) !== entry.sha256) {
      throw new Error(`Generated search file digest mismatch: ${entry.targetPath}`);
    }

    let sourceBytes = bytes;
    if (entry.targetPath.endsWith(".ts")) {
      const sourceFile = entry.sourcePath.slice(`${SEARCH_CONTRACT_SOURCE_PACKAGE}/`.length);
      const header = generatedHeader(manifest.sourceCommit, sourceFile);
      const contents = bytes.toString("utf8");
      if (!contents.startsWith(header)) {
        throw new Error(`Generated search provenance header mismatch: ${entry.targetPath}`);
      }
      sourceBytes = bytes.subarray(Buffer.byteLength(header));
      validatePortableImports(sourceBytes.toString("utf8"), entry, generatedTypeScriptFiles);
    }
    if (digest(sourceBytes) !== entry.sourceSha256) {
      throw new Error(`Generated search source digest mismatch: ${entry.targetPath}`);
    }
    generatedFiles.set(entry.targetPath, bytes);
  }

  for (const directory of ["src/core/search", "test/fixtures/search"]) {
    const existing = new Set(await listFiles(path.join(repositoryRoot, directory), repositoryRoot));
    const expected = new Set([...expectedFiles].filter((file) => file.startsWith(`${directory}/`)));
    if (existing.size !== expected.size || [...existing].some((file) => !expected.has(file))) {
      throw new Error(`Generated search files differ from the manifest under ${directory}`);
    }
  }

  if (options.sourceRepo && options.mergedParent) {
    const sourceRepo = path.resolve(options.sourceRepo);
    validateSourceRepository(sourceRepo);
    const verifiedParent = verifyMergedProvenance(
      sourceRepo,
      manifest.sourceCommit,
      options.mergedParent,
    ).toLowerCase();
    if (
      manifest.sourceState !== "merged-provenance-verified" ||
      manifest.mergedParent !== verifiedParent
    ) {
      throw new Error("Manifest must be regenerated from the merged source SHA before landing verification");
    }
    for (const entry of manifest.files) {
      const sourceBytes = readCommittedFile(sourceRepo, manifest.sourceCommit, entry.sourcePath);
      if (digest(sourceBytes) !== entry.sourceSha256) {
        throw new Error(`Pinned search source digest mismatch: ${entry.sourcePath}`);
      }
      const expectedBytes = entry.targetPath.endsWith(".ts")
        ? Buffer.concat([
            Buffer.from(
              generatedHeader(
                manifest.sourceCommit,
                entry.sourcePath.slice(`${SEARCH_CONTRACT_SOURCE_PACKAGE}/`.length),
              ),
            ),
            sourceBytes,
          ])
        : sourceBytes;
      if (!generatedFiles.get(entry.targetPath)?.equals(expectedBytes)) {
        throw new Error(
          `Generated search content does not match pinned source: ${entry.targetPath}`,
        );
      }
    }
  }

  process.stdout.write(
    `Verified ${manifest.files.length} generated search files offline (${manifest.sourceCommit}; ${manifest.sourceState})\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
