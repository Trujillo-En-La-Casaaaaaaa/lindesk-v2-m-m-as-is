Migrate the provided ShopFlow MVC application to a MEDIUM ARCHITECTURAL COMPLEXITY three-repository, three-tier architecture.

The migration must preserve the existing externally observable behavior.

CREATE EXACTLY THESE THREE REPOSITORIES

1. shopflow-web
2. shopflow-api
3. shopflow-infra

TARGET ARCHITECTURE

shopflow-web:

- React + TypeScript frontend.
- Must not access the database directly.

shopflow-api:

- TypeScript + Node.js backend.
- Must follow Hexagonal Architecture.
- Separate:
  - domain;
  - application/use cases;
  - ports;
  - adapters.

shopflow-infra:

- Docker Compose.
- PostgreSQL environment/migrations where appropriate.
- Deterministic local notification-provider emulator.

PRESERVATION REQUIREMENTS

The migrated system must preserve:

1. Product catalog.
2. Product inventory.
3. Order creation.
4. Inventory validation.
5. Inventory decrement.
6. Order detail/status.
7. Administrative transition to SHIPPED.
8. Order-confirmation notification.

Do not add customer order cancellation.

Preserve business behavior and data semantics.

Provide automated tests demonstrating behavioral preservation.

Do not create repositories other than the three specified above.
Do not add unrelated functionality.

The goal is architectural migration, not feature development.
