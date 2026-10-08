import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { verifyMergedProvenance } from "../../scripts/search-contract-source.mjs";

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

test("merged provenance rejects an unmerged source SHA even when the supplied parent is on main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-contract-provenance-"));
  const remote = path.join(root, "origin.git");
  const source = path.join(root, "source");

  try {
    git(root, "init", "--bare", "--initial-branch=main", remote);
    await mkdir(source, { recursive: true });
    git(root, "init", "--initial-branch=main", source);
    git(source, "config", "user.name", "Search contract test");
    git(source, "config", "user.email", "search-contract@example.test");
    git(
      source,
      "config",
      `url.file://${remote}/.insteadOf`,
      "https://github.com/W3DevTech/routermcp.git",
    );
    git(source, "remote", "add", "origin", "https://github.com/W3DevTech/routermcp.git");

    await writeFile(path.join(source, "README.md"), "base\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "base");
    const mainSha = git(source, "rev-parse", "HEAD");
    git(source, "push", "origin", "HEAD:refs/heads/main");

    git(source, "switch", "-c", "feat/search/h02-contract");
    await writeFile(path.join(source, "README.md"), "unmerged search source\n");
    git(source, "commit", "-am", "add search contract");
    const sourceSha = git(source, "rev-parse", "HEAD");
    git(source, "push", "origin", "HEAD:refs/heads/feat/search/h02-contract");

    assert.notEqual(sourceSha, mainSha);
    assert.throws(
      () => verifyMergedProvenance(source, sourceSha, mainSha),
      /source commit is not contained in refreshed canonical origin\/main/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
