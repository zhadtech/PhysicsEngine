# @physics/api

Fastify over PostgreSQL: scenes CRUD + the revision/publish FSM, auth (DB sessions, argon2id, PKCE OAuth), remix lineage, thumbnails, and later the AI proxy, community surface and verification queue.

- **Contract:** `docs/05-BACKEND.md` — the normative spec this package implements.
- **Roadmap phase:** **P4** (`docs/12-ROADMAP.md` §3).

## Status

Skeleton only. P4 is the MVP/Beta line — the point at which the product is a platform rather than a local toy. `openapi.yaml`, `schema.sql` and `types/api.ts` move in here.

The definition of done for P4 is an **existing** CI gate, not a new criterion
(`docs/12-ROADMAP.md` §5) — implementation wires stubbed steps to real package
output and never redraws the finish line.
