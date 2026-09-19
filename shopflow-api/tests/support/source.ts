import fs from "node:fs";
import path from "node:path";

export interface SourceFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".git", "coverage"]);

export function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

/** Every file below `directory` (relative to the repository root), ignoring build output and VCS. */
export function listFiles(directory: string, extension = ""): string[] {
  const root = repositoryRoot();
  const start = path.join(root, directory);
  const found: string[] = [];

  const walk = (current: string): void => {
    if (!fs.existsSync(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (extension === "" || entry.name.endsWith(extension)) {
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };

  walk(start);
  return found.sort();
}

export function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot(), relativePath), "utf8");
}

/** Remove line and block comments so only executable code is analysed. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Static and dynamic import specifiers of a TypeScript module. */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

export function isInside(directory: string, relativePath: string): boolean {
  return relativePath === directory || relativePath.startsWith(`${directory}/`);
}
