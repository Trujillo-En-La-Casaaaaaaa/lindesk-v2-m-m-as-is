# ShopFlow F1 — Low MVC (frozen fixture)

Experimental fixture for LinDesk evaluation. **No customer order cancellation.**

## Startup

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/api/health
```

App: http://127.0.0.1:3000  
Postgres on host port `5433`.

## Tests

```bash
npm install
npm test
```

Black-box acceptance (from `lindesk-evaluation`):

```powershell
..\..\..\scripts\run-acceptance.ps1 -Target . -Suite baseline -StartCompose
```

## Architecture

MVC-style separation under `src/`:

- `controllers/` — HTTP handlers and HTML views
- `services/` — application logic + notification adapter
- `repositories/` — persistence
- `models/` — entities
- `db/` — pool + migrations

## Seed

| ID | Name | Stock |
| --- | --- | ---: |
| prod-a | Product A | 20 |
| prod-b | Product B | 10 |
