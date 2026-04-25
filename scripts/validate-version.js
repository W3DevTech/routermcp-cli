#!/usr/bin/env node

/**
 * Version validation script for release workflow
 * Validates that the new version follows semver rules and doesn't skip major/minor versions
 *
 * Usage: node scripts/validate-version.js <current-version> <new-version>
 *
 * Rules:
 * - New version must be greater than current version
 * - Cannot skip major versions (0.x.x -> 2.x.x is invalid)
 * - Cannot skip minor versions within same major (0.1.x -> 0.3.x is invalid)
 * - Pre-release versions are supported (0.2.0-beta.1, 0.2.0-rc.1)
 */

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parse a semver string into components
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | null, build: string | null } | null}
 */
function parseSemver(version) {
  // Strip leading 'v' if present
  const cleanVersion = version.startsWith("v") ? version.slice(1) : version;
  const match = cleanVersion.match(SEMVER_REGEX);

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
  };
}

/**
 * Compare two semver versions (ignoring prerelease for base comparison)
 * @param {ReturnType<typeof parseSemver>} a
 * @param {ReturnType<typeof parseSemver>} b
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
function compareVersions(a, b) {
  if (!a || !b) return 0;

  // Compare major
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;

  // Compare minor
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;

  // Compare patch
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  // Handle prerelease comparison
  // A version without prerelease is greater than one with prerelease
  // e.g., 1.0.0 > 1.0.0-beta.1
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease === null && b.prerelease === null) return 0;

  // Both have prerelease, compare them lexicographically with numeric awareness
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNum = parseInt(aPart, 10);
    const bNum = parseInt(bPart, 10);

    // Both are numeric
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    }
    // Numeric identifiers have lower precedence than alphanumeric
    else if (!isNaN(aNum)) {
      return -1;
    } else if (!isNaN(bNum)) {
      return 1;
    }
    // Both are alphanumeric, compare lexicographically
    else {
      if (aPart < bPart) return -1;
      if (aPart > bPart) return 1;
    }
  }

  return 0;
}

/**
 * Validate version transition rules
 * @param {ReturnType<typeof parseSemver>} current
 * @param {ReturnType<typeof parseSemver>} next
 * @returns {{ valid: boolean, error?: string }}
 */
function validateVersionTransition(current, next) {
  if (!current || !next) {
    return { valid: false, error: "Invalid version format" };
  }

  // Check if new version is greater than current
  if (compareVersions(next, current) <= 0) {
    return {
      valid: false,
      error: `New version must be greater than current version (${current.major}.${current.minor}.${current.patch}${current.prerelease ? `-${current.prerelease}` : ""})`,
    };
  }

  // For prerelease versions targeting a future release, we need different rules
  // e.g., 0.1.9 -> 0.2.0-beta.1 is valid (preparing for 0.2.0)
  const nextBaseVersion = { ...next, prerelease: null };
  const currentBaseVersion = { ...current, prerelease: null };

  // Check major version skip
  // Can only increment major by 1 at a time
  if (next.major > current.major + 1) {
    return {
      valid: false,
      error: `Cannot skip major versions. Current: ${current.major}.x.x, attempted: ${next.major}.x.x. You must release ${current.major + 1}.0.0 first.`,
    };
  }

  // When incrementing major, minor and patch should reset to 0
  // (unless it's a prerelease for that major)
  if (next.major > current.major) {
    // This is a major version bump, minor should be 0
    if (next.minor !== 0) {
      return {
        valid: false,
        error: `When incrementing major version, minor should be 0. Use ${next.major}.0.0 instead of ${next.major}.${next.minor}.${next.patch}`,
      };
    }
    // Valid major bump
    return { valid: true };
  }

  // Same major version - check minor version skip
  if (next.minor > current.minor + 1) {
    return {
      valid: false,
      error: `Cannot skip minor versions. Current: ${current.major}.${current.minor}.x, attempted: ${current.major}.${next.minor}.x. You must release ${current.major}.${current.minor + 1}.0 first.`,
    };
  }

  // When incrementing minor, patch should reset to 0
  if (next.minor > current.minor && next.patch !== 0) {
    return {
      valid: false,
      error: `When incrementing minor version, patch should be 0. Use ${next.major}.${next.minor}.0 instead of ${next.major}.${next.minor}.${next.patch}`,
    };
  }

  return { valid: true };
}

// Main execution
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node scripts/validate-version.js <current-version> <new-version>");
    process.exit(1);
  }

  const [currentVersion, newVersion] = args;

  const current = parseSemver(currentVersion);
  const next = parseSemver(newVersion);

  if (!current) {
    console.error(`Invalid current version format: ${currentVersion}`);
    process.exit(1);
  }

  if (!next) {
    console.error(`Invalid new version format: ${newVersion}`);
    console.error("Version must follow semver format: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]");
    console.error("Examples: 1.0.0, 1.0.0-beta.1, 1.0.0-rc.1, 1.0.0-alpha.1+build.123");
    process.exit(1);
  }

  const result = validateVersionTransition(current, next);

  if (!result.valid) {
    console.error(`Version validation failed: ${result.error}`);
    process.exit(1);
  }

  console.log(`Version transition validated: ${currentVersion} -> ${newVersion}`);
  process.exit(0);
}

main();
