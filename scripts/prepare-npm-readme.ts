import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const packageJsonPath = join(process.cwd(), "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

const npmReadme = (packageJson as any).npmReadme || "README-npm.md";
const readmePath = join(process.cwd(), npmReadme);
const targetReadmePath = join(process.cwd(), "README.md");

if (!existsSync(readmePath)) {
  console.error(`Error: ${npmReadme} not found`);
  process.exit(1);
}

const backupPath = join(process.cwd(), "README.md.backup");
if (existsSync(targetReadmePath)) {
  writeFileSync(backupPath, readFileSync(targetReadmePath, "utf-8"));
  console.log(`Backed up README.md to README.md.backup`);
}

writeFileSync(targetReadmePath, readFileSync(readmePath, "utf-8"));
console.log(`Copied ${npmReadme} to README.md for npm publishing`);


