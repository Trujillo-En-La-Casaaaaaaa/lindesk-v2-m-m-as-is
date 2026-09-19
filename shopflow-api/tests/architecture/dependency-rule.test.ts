import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  importSpecifiers,
  isInside,
  listFiles,
  readSource,
  repositoryRoot,
  stripComments,
} from "../support/source.js";

const CORE_LAYERS = ["src/domain", "src/application"];
const FORBIDDEN_PACKAGES = ["express", "pg"];
const SQL_STATEMENT =
  /\b(SELECT\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|ALTER\s+TABLE\b|DROP\s+TABLE\b)/i;

describe("hexagonal dependency rule", () => {
  it("uses the required repository layout", () => {
    const root = repositoryRoot();
    const requiredPaths = [
      "package.json",
      "tsconfig.json",
      "Dockerfile",
      ".dockerignore",
      ".env.example",
      "README.md",
      "src/main.ts",
      "src/config/env.ts",
      "src/domain",
      "src/application/ports/in",
      "src/application/ports/out",
      "src/application/use-cases",
      "src/adapters/inbound/http",
      "src/adapters/outbound/postgres",
      "src/adapters/outbound/notification",
      "src/adapters/outbound/outbox",
      "tests/unit",
      "tests/integration",
      "tests/contract",
      "tests/characterization",
      "tests/architecture",
    ];
    for (const requiredPath of requiredPaths) {
      expect(fs.existsSync(path.join(root, requiredPath)), `${requiredPath} is missing`).toBe(true);
    }

    const requiredFiles = [
      "src/domain/product.ts",
      "src/domain/order.ts",
      "src/domain/order-status.ts",
      "src/domain/notification.ts",
      "src/domain/errors.ts",
      "src/domain/pricing.ts",
      "src/application/ports/in/list-products.ts",
      "src/application/ports/in/get-product.ts",
      "src/application/ports/in/create-order.ts",
      "src/application/ports/in/get-order.ts",
      "src/application/ports/in/ship-order.ts",
      "src/application/ports/in/list-notifications.ts",
      "src/application/ports/in/deliver-pending-notifications.ts",
      "src/application/ports/out/product-repository.ts",
      "src/application/ports/out/order-repository.ts",
      "src/application/ports/out/unit-of-work.ts",
      "src/application/ports/out/notification-port.ts",
      "src/application/ports/out/notification-outbox.ts",
      "src/application/ports/out/clock.ts",
      "src/application/ports/out/id-generator.ts",
      "src/application/use-cases/list-products.use-case.ts",
      "src/application/use-cases/get-product.use-case.ts",
      "src/application/use-cases/create-order.use-case.ts",
      "src/application/use-cases/get-order.use-case.ts",
      "src/application/use-cases/ship-order.use-case.ts",
      "src/application/use-cases/list-notifications.use-case.ts",
      "src/application/use-cases/deliver-pending-notifications.use-case.ts",
      "src/adapters/inbound/http/server.ts",
      "src/adapters/inbound/http/router.ts",
      "src/adapters/inbound/http/controllers.ts",
      "src/adapters/inbound/http/error-mapping.ts",
      "src/adapters/inbound/http/request-validation.ts",
      "src/adapters/outbound/postgres/pool.ts",
      "src/adapters/outbound/postgres/row-mappers.ts",
      "src/adapters/outbound/postgres/product-repository.pg.ts",
      "src/adapters/outbound/postgres/order-repository.pg.ts",
      "src/adapters/outbound/postgres/unit-of-work.pg.ts",
      "src/adapters/outbound/postgres/notification-outbox.pg.ts",
      "src/adapters/outbound/notification/http-notification.adapter.ts",
      "src/adapters/outbound/outbox/outbox.relay.ts",
    ];
    for (const requiredFile of requiredFiles) {
      expect(fs.existsSync(path.join(root, requiredFile)), `${requiredFile} is missing`).toBe(true);
    }
  });

  it("lets src/domain and src/application import neither express, pg nor adapters", () => {
    const violations: string[] = [];

    for (const layer of CORE_LAYERS) {
      for (const file of listFiles(layer, ".ts")) {
        for (const specifier of importSpecifiers(readSource(file))) {
          const packageName = specifier.split("/")[0] ?? specifier;
          if (FORBIDDEN_PACKAGES.includes(packageName)) {
            violations.push(`${file} imports ${specifier}`);
          }
          if (specifier.includes("adapters")) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the domain layer free of application imports (inward dependencies only)", () => {
    const violations: string[] = [];

    for (const file of listFiles("src/domain", ".ts")) {
      for (const specifier of importSpecifiers(readSource(file))) {
        if (specifier.includes("application") || specifier.includes("config") || specifier.includes("main")) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("confines SQL to src/adapters/outbound/postgres", () => {
    const violations: string[] = [];

    for (const file of listFiles("src", ".ts")) {
      if (isInside("src/adapters/outbound/postgres", file)) {
        continue;
      }
      const code = stripComments(readSource(file));
      if (SQL_STATEMENT.test(code)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });

  it("ships no DDL, migration or ORM artefact", () => {
    const root = repositoryRoot();
    const executables = listFiles("src", ".ts");
    const ddl = /\b(CREATE\s+(TABLE|INDEX|SCHEMA|TYPE)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|TRUNCATE)\b/i;

    for (const file of executables) {
      expect(ddl.test(stripComments(readSource(file))), `${file} contains DDL`).toBe(false);
    }

    // No SQL file anywhere in the repository: the schema is owned by shopflow-infra.
    expect(listFiles(".", ".sql")).toEqual([]);
    for (const forbidden of ["migrations", "db/migrate.ts", "prisma", "typeorm", "sequelize"]) {
      expect(fs.existsSync(path.join(root, forbidden)), `${forbidden} must not exist`).toBe(false);
    }

    const packageJson = JSON.parse(readSource("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    });
    for (const orm of ["typeorm", "prisma", "@prisma/client", "sequelize", "knex", "drizzle-orm", "mongoose"]) {
      expect(declared, `${orm} must not be a dependency`).not.toContain(orm);
    }
    expect(declared).toEqual(
      expect.arrayContaining(["express", "pg"]),
    );
  });

  it("exposes no cancellation surface in the source tree", () => {
    const violations: string[] = [];
    const standaloneCancel = /\bcancel(?!l)/i;

    for (const file of listFiles("src", ".ts")) {
      if (standaloneCancel.test(file)) {
        violations.push(`${file} (file name)`);
      }
      for (const specifier of importSpecifiers(readSource(file))) {
        if (standaloneCancel.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
    // The dormant legacy values stay available (data compatibility) but are never produced.
    expect(readSource("src/domain/order-status.ts")).toContain("CANCELLED");
  });
});
