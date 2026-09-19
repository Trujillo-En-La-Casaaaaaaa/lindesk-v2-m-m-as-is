/** @vitest-environment node */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Automated guard for the boundary "shopflow-web must not access the database directly".
 *
 * It fails when any first-party file or any (declared, installed or transitively locked) dependency
 * references a database driver or a connection string, and it also pins the packaging boundary
 * (static assets + `/api/*` proxy only, no Node runtime and no database client in the image).
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

const SCANNED_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "nginx.conf",
  "Dockerfile",
  ".env.example",
  "README.md",
];
const SCANNED_DIRECTORIES = ["src", "tests"];
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "dist", ".git", "coverage"]);
const TEXT_FILE_EXTENSIONS = [".ts", ".tsx", ".css", ".json", ".md", ".html", ".conf", ".example", ".js", ".mjs"];

const FORBIDDEN_DRIVER_NAMES =
  /^(?:pg|pg-[a-z0-9-]+|postgres|postgresql|mysql|mysql2|mariadb|sqlite|sqlite3|better-sqlite3|mongodb|mongodb-[a-z0-9-]+|mongoose|knex|sequelize|typeorm|prisma|@prisma\/[a-z0-9-]+|oracledb|mssql)$/;

const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "database driver import",
    pattern:
      /\b(?:from|require\s*\()\s*["'](?:pg|pg-[a-z0-9-]+|postgres|mysql2?|mariadb|sqlite3?|better-sqlite3|mongodb|mongoose|knex|sequelize|typeorm|prisma|oracledb|mssql)["']/i,
  },
  {
    label: "database driver reference",
    pattern:
      /["'](?:pg|postgres|postgresql|mysql2?|mariadb|sqlite3?|better-sqlite3|mongodb|mongoose|knex|sequelize|typeorm|prisma|oracledb|mssql)["']/i,
  },
  {
    label: "connection string",
    pattern: /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\//i,
  },
  {
    label: "connection-string variable",
    pattern:
      /\b(?:DATABASE_URL|POSTGRES_(?:USER|PASSWORD|HOST|PORT|DB)|MYSQL_(?:USER|PASSWORD|HOST)|PG(?:HOST|PORT|USER|PASSWORD|DATABASE))\b/,
  },
  {
    label: "SQL statement",
    pattern:
      /\b(?:SELECT\s+[A-Za-z0-9_*"',. ]+\s+FROM|INSERT\s+INTO|UPDATE\s+[A-Za-z0-9_."]+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX)|DROP\s+TABLE|ALTER\s+TABLE)\b/i,
  },
];

function collectScannedFiles(): string[] {
  const files: string[] = [];

  for (const name of SCANNED_ROOT_FILES) {
    const candidate = join(REPO_ROOT, name);
    if (existsSync(candidate)) {
      files.push(candidate);
    }
  }

  for (const directory of SCANNED_DIRECTORIES) {
    const candidate = join(REPO_ROOT, directory);
    if (existsSync(candidate)) {
      walk(candidate, files);
    }
  }

  return files.filter((file) => file !== THIS_FILE);
}

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (TEXT_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(full);
    }
  }
}

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function toRelative(absolutePath: string): string {
  return absolutePath.slice(REPO_ROOT.length).replace(/\\/g, "/");
}

function scan(pattern: RegExp): string[] {
  return collectScannedFiles()
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map(toRelative);
}

describe("no database access guard", () => {
  it("scans the first-party sources and the packaging files", () => {
    const scanned = collectScannedFiles().map(toRelative);

    expect(scanned).toContain("src/api/client.ts");
    expect(scanned).toContain("tests/mocks/handlers.ts");
    expect(scanned).toContain("package.json");
    expect(scanned).toContain(".env.example");
    expect(scanned.filter((file) => file.includes("node_modules"))).toEqual([]);
    expect(scanned.length).toBeGreaterThan(15);

    // This guard names the forbidden patterns, so it excludes itself from its own scan.
    expect(collectScannedFiles()).not.toContain(THIS_FILE);
  });

  it("references no database driver, connection string or SQL statement in any file", () => {
    for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
      expect(scan(pattern), `files containing a ${label}`).toEqual([]);
    }
  });

  it("declares and installs no database dependency", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared.filter((name) => FORBIDDEN_DRIVER_NAMES.test(name))).toEqual([]);

    const lockfile = JSON.parse(read("package-lock.json")) as { packages?: Record<string, unknown> };
    const installed = Object.keys(lockfile.packages ?? {}).map(
      (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    );
    expect(installed.filter((name) => name !== "" && FORBIDDEN_DRIVER_NAMES.test(name))).toEqual([]);
  });

  it("exposes only VITE_API_BASE and no host, credential or database setting", () => {
    const envKeys = read(".env.example")
      .split(/\r?\n/)
      .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim())?.[1])
      .filter((key): key is string => key !== undefined);
    expect(envKeys).toEqual(["VITE_API_BASE"]);

    const srcFiles = collectScannedFiles()
      .map(toRelative)
      .filter((file) => file.startsWith("src/"));
    const referencedEnvKeys = new Set<string>();
    for (const file of srcFiles) {
      const source = read(file);
      expect(source, `${file} must not read process.env`).not.toMatch(/process\.env/);
      expect(source, `${file} must not hardcode a hostname`).not.toMatch(/https?:\/\//);
      for (const match of source.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) {
        referencedEnvKeys.add(match[1]!);
      }
    }
    expect([...referencedEnvKeys]).toEqual(["VITE_API_BASE"]);
  });

  it("keeps the packaging static: SPA fallback plus an /api/ proxy that keeps the prefix", () => {
    const nginx = read("nginx.conf");
    expect(nginx).toContain("location /api/");
    expect(nginx).toContain("proxy_pass http://api:3001;");
    expect(nginx).toContain("root /usr/share/nginx/html;");
    expect(nginx).toContain("try_files $uri $uri/ /index.html;");
    expect(nginx, "the /api prefix must reach the API unchanged").not.toMatch(/rewrite/);

    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("FROM node:22-alpine AS build");
    expect(dockerfile).toContain("FROM nginx:alpine");
    expect(dockerfile).toContain("EXPOSE 80");
    expect(dockerfile).toContain("COPY --from=build /app/dist /usr/share/nginx/html");

    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM nginx:alpine"));
    expect(runtimeStage, "the runtime image must not install or ship Node tooling").not.toMatch(
      /\bnpm\b|node_modules/,
    );
  });
});
