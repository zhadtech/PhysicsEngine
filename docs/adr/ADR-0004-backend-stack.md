# ADR-0004: Backend Stack — Node.js + TypeScript + Fastify + PostgreSQL

- **Status:** Accepted
- **Date:** 2026-07-19 (Session 1)

## Context

The backend does accounts, persistence, search, sharing, likes, comments, follows, challenges, trending, leaderboards — and explicitly **no physics**. It should be cheap, boring, and horizontally scalable, and it must validate uploaded scenes with exactly the same rules as the client.

## Decision

| Layer | Choice |
|-------|--------|
| Runtime / language | Node.js + TypeScript |
| HTTP framework | Fastify (OpenAPI-first; schema-validated routes) |
| Database | PostgreSQL (relational core + `JSONB` for scene documents in MVP) |
| Cache / rate limiting / hot lists | Redis |
| Object storage + CDN | S3-compatible storage behind a CDN (thumbnails, future assets) |
| Background jobs | Lightweight queue (BullMQ on Redis) for trending/leaderboard recompute, cleanup |
| API style | REST + OpenAPI spec (public-API-friendly, cacheable GETs) |
| Deployment shape | Stateless containers + managed Postgres/Redis (vendor-neutral; picked in M9) |

## Rationale

- **Same language as the client is a feature, not a convenience:** the `scene-format` package (TypeScript types + JSON Schema validation + migrations) runs identically on both sides — one source of truth for what a valid scene is. This eliminates an entire class of client/server drift bugs.
- **Deterministic-WASM dividend:** Node can load the *same* Rapier WASM build as the browser, enabling future server-side replay spot-verification for leaderboards (Risk R2) with no new infrastructure paradigm.
- **Fastify:** fast, mature, first-class JSON-schema request/response validation that we can generate from the OpenAPI spec (M4).
- **PostgreSQL:** relational fits the social graph (users, likes, comments, follows, remix lineage); `JSONB` holds scenes without a second datastore at MVP scale; full-text + trigram covers MVP search.
- **REST over tRPC/GraphQL:** a public creations platform wants a documentable, cacheable, third-party-consumable API; GraphQL's flexibility isn't needed for these access patterns and complicates caching and rate limiting.

## Consequences

- Scene size cap enforced at API boundary (~1 MB compressed initially); if real scenes outgrow JSONB comfortably, move scene bodies to object storage keeping metadata in Postgres — schema in M4 is designed so this swap is non-breaking (open question U3).
- Trending/leaderboards are periodic-job outputs (materialized tables), not query-time aggregations — keeps read paths cheap.
- All social write endpoints are rate-limited via Redis from day one (abuse surface: comments, likes, uploads).

## Alternatives considered

- **Supabase / Firebase (BaaS):** fastest start, but leaderboard jobs, remix lineage queries, replay verification, and rate-limiting logic all become awkward or vendor-locked; migration cost later exceeds savings now.
- **Go or Rust backend:** performance we don't need at the cost of losing shared scene validation/types with the client — the single strongest argument in this ADR.
- **GraphQL:** see rationale; revisit only if third-party developers demand flexible queries.
- **MongoDB:** JSON-native storage, but the social graph is relational and Postgres JSONB already covers the document need.
