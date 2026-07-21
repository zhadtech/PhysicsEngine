# 11 — Multiplayer/Collaboration Roadmap & Monetization

**Status:** Accepted (Session 11, 2026-07-22) — a **design sketch + options analysis**, not an implementation spec. It fixes the *architecture* of post-MVP collaboration and monetization and de-risks the one load-bearing claim (co-editing is compatible with determinism); concrete transport, endpoints, and prices are named as open issues.
**Implements:** the brief's items 11 (multiplayer/collaboration roadmap) and 12 (monetization ideas)
**Consumes:** `01-ARCHITECTURE.md` (§1 non-goals, §3.3 edit/play FSM, §6 versioning), `02-SCENE-FORMAT.md` (§7 limits, §8 validation rules, §9 versioning), `04-BUILDER-UX.md` (§9 undo model, §14 autosave), `05-BACKEND.md` (§3.2 revisions, §5.3 validation gate, §6.6 PATs, §7 conflict model, §8 quotas), `07-AI-PIPELINE.md` (§7.3 AI quota), `08-COMMUNITY.md` (§5 verification, §6 challenges, §7 moderation), `10-INFRASTRUCTURE.md` (§2 topology, §3 isolation)
**Companion file:** `types/monetization.ts` (collaboration model constants, plans/entitlements, public-API sketch — compile-tied so the free tier equals the shipped MVP and the format/engine caps cannot be sold past)
**Consumed by:** M11 (the consolidated MVP→production roadmap places these as post-MVP phases); a future dedicated collaboration milestone (the full sync-service spec)

---

## 1. Scope and principles

M10 is a **roadmap milestone**. Like M8/M9 it adds **no new API operation, DB table, error code, or engine constant** — `openapi.yaml`, `schema.sql`, `scene.schema.json`, and the engine constants are untouched, and `verify-backend.mjs`/`verify.mjs` need no change. The only build-time additions are `types/monetization.ts` and this document. Real-time co-editing and billing are *future* surfaces; this milestone commits to their shape, not their code.

Principles that govern both halves:

1. **Collaboration mutates *inputs*, never the *run*.** The scene document is inputs-only (ADR-0005). Co-editing is concurrent mutation of that document; play is the same deterministic, client-side function it always was. This is the hinge that lets multiplayer coexist with leaderboards (§3).
2. **Reuse the correctness we already have.** A convergent merge guarantees every replica lands on the same *bytes*; the *validity* of those bytes is enforced by the exact validation gate every save already runs (05 §5.3). Collaboration introduces no second notion of "a valid scene" (§2.4).
3. **The stateless backend stays stateless.** Real-time sync is genuinely stateful and breaks 01 §1's non-goal — so it lives in its own service, and the CRUD API (05) does not change (§4.1). We spend the exception deliberately and contain it.
4. **Never sell backwards.** The free tier is, by construction, the entitlement set M0–M9 already shipped; paid tiers are strictly additive. And the invariants that protect determinism and the format (object cap, body cap) are identical on every plan — not for sale at any price (§6.2).
5. **Sketch, don't overreach.** Where a decision needs real users, real traffic, or a market (prices, payout economy, the socket transport), this document names the open issue rather than inventing a number.

---

## 2. The collaboration model — a convergent CRDT over the scene document

### 2.1 Why the MVP conflict model does not generalize

05 §7 / 04 §14 resolve *single-writer* conflicts by **fork-on-conflict**: two devices that both saved get a three-way dialog (keep server / save mine as copy / overwrite), and **no merge is ever attempted** because "scene JSON merge semantics are undefined and silently wrong merges destroy machines." That is correct for asynchronous saves by one owner. It cannot serve *simultaneous* editing by several people: you cannot pop a conflict dialog on every keystroke, and "save mine as a copy" is not collaboration — it is the absence of it.

Real-time co-editing therefore needs a merge function that is **defined, convergent, and total** — one that takes any two concurrent edit histories to the *same* document regardless of order, with no user prompt. That is exactly what a CRDT provides.

### 2.2 CRDT over OT

Two families solve convergent shared editing:

- **Operational Transformation (OT)** transforms each operation against concurrent ones. It is proven for linear text but needs a central authority to order/transform, and correct transform functions for a *structured* document (nested objects, links, props) are notoriously hard to get right.
- **CRDTs** make the merge a mathematical join (commutative, associative, idempotent), so replicas converge with no central transform step and tolerate P2P or offline edits.

A scene is not linear text; it is a **keyed collection** — a map of objects and a map of links, each a small record of scalar fields, over a handful of world settings. That shape maps cleanly onto well-understood CRDTs, so we choose **CRDT** (`COLLAB.MODEL`). The concrete structure:

- **Object & link presence** — an **add-wins observed-remove map** (AWOR). Each add is tagged with a unique dot `(siteId, counter)`; a remove tombstones exactly the add-dots it *observed*. An element is present iff it has an add-dot no remove has covered. "Add-wins" means a concurrent *create* is never silently lost to a delete that could not have seen it — the safe bias for authoring.
- **Fields** (`type`, `pos`, `rot`, `props`, and each `world` setting) — a **last-writer-wins register** keyed by `(lamport, siteId)`, ties broken on `siteId`. A total order over writes ⇒ a deterministic winner.

Merge is the union of the grow-only dot sets plus the max-ordered pick per register — commutative, associative, idempotent by construction.

### 2.3 What the spike proved

The M10 spike (`crdt-spike.mjs`, §7) implemented exactly this structure and ran two divergent concurrent edit sessions over a base scene (Alice nudges the marble, adds a domino, deletes `d2`; Bob changes gravity + plane angle and adds a rope link):

- **Convergence.** 200 random delivery orders of the combined op log produced **byte-identical** documents; duplicate re-delivery was idempotent. Order independence is not asserted — it is exercised.
- **Structural validity.** The converged document passed the **real `scene.schema.json`** under ajv-strict. A merge cannot produce a structurally malformed scene.

### 2.4 The load-bearing finding: convergence is not integrity — and that is fine

The spike deliberately baited the sharp case: Bob adds a link `L1` whose endpoint `b` references `d2`, *while* Alice deletes `d2`. The CRDT converges — `d2` is gone (add-wins delete, no concurrent re-add), `L1` survives (add-wins) — and the result **passes the JSON Schema**. But `L1` now references an object that no longer exists: a **dangling reference**.

This is the important part. Referential integrity is a **02 §8 semantic rule (an E-rule)**, which the JSON Schema deliberately does not encode (structural vs. semantic is a standing split, 05 §5.3). So the CRDT gives us *structural* convergence for free, and the *semantic* soundness of the merge is restored by the machinery that **already exists**: the merge is followed by the same validation gate every save runs (`COLLAB.MERGE_THEN_GATE`). For the one class the merge can introduce — endpoints orphaned by a concurrent delete — the repair is a **deterministic, order-independent link-GC**: prune any link whose endpoint vanished. Because it is a pure function of the converged document, **both replicas compute the identical repaired bytes with no coordination** — the spike confirmed the forward-order and reverse-order replicas produced the same repaired document, dangling link pruned, gate green.

The design consequence is the whole thesis of §2: **collaboration adds no new correctness model.** It adds a convergent merge and reuses the existing gate. (Undo/redo, 04 §9, becomes per-site: each collaborator undoes their *own* operations — a standard CRDT undo, out of scope for this sketch beyond noting it.)

---

## 3. Determinism under shared editing

The reason this is safe for leaderboards is one sentence: **editing mutates inputs; playing is a pure function of `(document, engineVersion)`.**

- Co-editing changes the scene document. The merged+repaired document is an ordinary `Scene` — nothing about it is special to collaboration.
- A *run* over any fixed document is byte-identical: proven same-process (S3), **cross-process** (S8 E1), and **Node≡Chromium** (S10 I2 — hash `e4dc73ff`). The verification job (08 §5) recomputes rankable metrics from the document alone.
- Therefore collaboration never touches determinism. When collaborators press Play, **each plays locally** and independently; given the same shared document and seed they see identical physics because the engine is deterministic, not because anything is synchronized (`COLLAB.PLAY_IS_LOCAL_DETERMINISTIC`).

**Shared *playback*** — a synchronized run where everyone watches the same stepping world in lockstep — is explicitly **out of scope** for the v1 sketch. It is unnecessary (determinism already gives everyone the same movie from the same document) and it would reintroduce a stateful, latency-sensitive coupling we do not need. If a "watch together" feature is ever wanted, it is a thin presentation layer (one peer's step index broadcast as a scrub position), not a change to the simulation contract.

One subtlety worth recording: a leaderboard entry pins an **exact revision** (08 §6, D18). Collaboration produces revisions via checkpoint/explicit-save (§4.2), so a challenge entry is still a frozen document — co-authored, but immutable once entered. Shared editing and ranked competition do not interact beyond that.

---

## 4. The sync service & session model

### 4.1 A contained stateful exception

Real-time sync needs a server that holds live, in-memory session state (connected peers, the authoritative CRDT state, presence) and pushes updates over a persistent connection. That is stateful, and it **deliberately breaks 01 §1's "no real-time multiplayer editing" / stateless-backend non-goal** (`COLLAB.STATEFUL_SYNC_SERVICE`). We contain the blast radius:

- It is a **separate service** ("collab service"), not the Fastify CRUD API. The 05 API — and everything M9 said about stateless 12-factor pods (10 §2) — is unchanged.
- **Session ownership routes to a single node** (a document's session lives on one instance; a lightweight registry in Redis maps `sceneId → node`). This keeps the authoritative merge on one machine and sidesteps multi-primary CRDT sync for v1, while the CRDT property still protects offline/lagged clients and crash recovery.
- **Persistence reuses the scene store.** The live CRDT is checkpointed to the existing `scene_revisions` table (05 §3.2) — an **explicit save is still a revision**, and autosave-style checkpoints are periodic. Nothing new is stored; the collab service is a cache + relay over the durable document, and losing it costs a reconnect, never data.
- **Transport** (WebSocket vs. WebRTC data channels, auth over the socket, backpressure) is a full spec of its own → **U28**. The cross-origin isolation posture (10 §3) is unaffected: the collab socket is same-origin API traffic, not a SAB dependency.

### 4.2 Edit-session & presence model

- **Presence/awareness** — peer cursors, current selection, viewport — is **ephemeral**: Redis with a short TTL (`COLLAB.PRESENCE_TTL_S = 30`), never persisted, never a leaderboard or ranking input. It rides the same socket but is a separate channel from the CRDT ops.
- **Edit vs. test, per user.** 01 §3.3 / 04's edit⇄test FSM stays per-collaborator: any participant can drop into local test (play) on the *current shared document* without pausing others' editing — because play is local and deterministic (§3). Edits made while one peer is testing simply arrive as ops they'll see on their next reset.
- **Session size.** A session is a coordination unit, not a broadcast; presence fan-out is O(peers²) in the worst case, so there is a hard ceiling `COLLAB.MAX_SESSION_EDITORS = 16` independent of how many seats a plan grants (§6). Large "audiences" are a share-page/embed concern (04 §11), not a co-edit session.

### 4.3 U13 falls out for free

Server-side drafts / cross-device continue-editing (**U13**, deferred from 05 §7) is the **single-user degenerate case** of this machinery: one seat, zero peers, the CRDT checkpointed server-side so the draft follows you between devices (`COLLAB.SUBSUMES_U13`). It ships *with* collaboration rather than as separate sync infrastructure — which is exactly why 05 §7 deferred it here instead of solving it twice. The MVP behavior (local IndexedDB autosave, explicit-save-only server, 05 §6.5) remains the floor for the free tier and for anyone offline.

### 4.4 Roadmap staging

The collaboration surface is sequenced so each phase is independently shippable:

1. **Server drafts (U13)** — single-user CRDT checkpointed server-side; no presence, no peers. Smallest slice; proves the sync service + checkpoint path.
2. **Live co-edit (small sessions)** — add presence + multi-peer ops within the `MAX_SESSION_EDITORS` ceiling; single-node session ownership.
3. **Sharing & permissions** — invite/role model (owner/editor/viewer) over a session; ties to the 05 visibility FSM.
4. **(If ever) watch-together** — the thin shared-scrub layer of §3.

M11 places these as post-MVP phases; the full sync-service spec (transport, reconnection, permission model) is **U28**, its own milestone.

---

## 5. What multiplayer does *not* change

To keep the sketch honest about its own edges:

- **The scene format** is unchanged — a co-authored document is an ordinary `Scene`. CRDT metadata (dots, registers, lamports) lives in the **collab service's** state and its checkpoints, never in the canonical document that saves, validates, ranks, or exports.
- **Determinism / leaderboards** are unchanged (§3). A ranked entry is still a pinned, immutable revision.
- **The stateless CRUD API** is unchanged (§4.1).
- **Moderation** is unchanged: co-authored content is reported and actioned exactly like any scene (08 §7); the reported artifact is the saved revision.

---

## 6. Monetization

### 6.1 The model: a free floor that is the shipped product, additive paid tiers

Three plans — **free / plus / pro** (`PLANS`, `PLAN_IDS`). The organizing decision (**D25**) is a product-integrity one: **the free tier is, by construction, the entitlement set M0–M9 already shipped**, and paid tiers only ever *add*. `types/monetization.ts` proves this at compile time — `PLANS.free.maxActiveScenes === API.MAX_ACTIVE_SCENES`, and the AI/day floor is sourced from the live `RATE_LIMITS.aiCallsDay` bucket — so a change that quietly nerfs the free experience to manufacture a paywall fails to build. We do not take away what already works to sell it back.

### 6.2 What is *not* for sale — the invariants

Two caps are **identical on every plan**, proven by the `PlanRow[...]` ties in the companion:

- **Object cap per document** (`maxObjectsPerScene === LIMITS.maxObjects`, 5000) — a **scene-format invariant** (02 §7). A bigger cap is a schemaVersion change for everyone, not a per-seat upsell.
- **Dynamic-body hard cap** (`hardBodyCap === SIM.MAX_DYNAMIC_BODIES`, 8000) — a **determinism/rankability invariant** (03 §5.4). A scene that runs must run identically for everyone; you cannot buy a bigger physics world, because the leaderboard (and the 09 §7 `low`-tier guarantee) depend on the cap being universal.

This is the honest core of the model: **you cannot pay to change physics or the format.** It also happens to be the cleanest possible answer to "cosmetic vs. capability" (the brief's framing) — the capability that matters (the simulation itself) is deliberately outside the paywall.

### 6.3 The sellable levers

Everything sellable is **account-scoped quota or cosmetic**, never engine behavior:

| Lever | Free | Plus | Pro | Why it is fair to sell |
|---|---|---|---|---|
| Active scenes (`maxActiveScenes`) | 500 (shipped) | 2 000 | 10 000 | Storage cost scales with it; free floor already generous |
| AI calls/day (`aiCallsPerDay`) | 20 (shipped) | 100 | 500 | Direct provider cost (07 §7.3, D15) — the clearest metered good |
| Collaborator seats (`collaboratorSeats`) | 0 (solo) | 3 | 10 | Live-sync infra cost per concurrent editor (§4) |
| Premium skin packs (`premiumSkinPacks`) | 0 | 3 | 99 | Pure cosmetic; the 8 shipped skins stay free on every plan |
| Verify priority (`verifyPriority`) | standard | standard | priority | Priority changes the **wait, never the result** (determinism) — sellable without touching fairness |
| Public API (`apiAccess`) | none | read | full | PAT-gated programmatic access (§6.4) |
| Author challenges (`canAuthorChallenges`) | — | — | ✓ | U23: spam/incentive risk sits behind a paying, known actor |

Ordering `free ≤ plus ≤ pro` holds by construction on every lever (the companion documents the inequality). **Cosmetic skins** are the primary aesthetic upsell, but note the invariant: the shipped `SKIN_NAMES` set (8 skins, 04 §12.3) is free on every plan (`baseSkinCount === SKIN_NAMES.length`, proven) — premium packs are *additional*, never a repossession of what shipped.

**User-authored challenges (U23)** land here as a **pro entitlement** rather than as new moderation machinery: an authored challenge is created through the same closed rule vocabulary and revision-pinning as staff challenges (08 §6, D18) and is reported/actioned through the same moderation surface (08 §7, D19). Gating authoring to a paying tier is the spam/incentive control the MVP deferred.

### 6.4 The public-API story (05 §6.6 → M11)

05 §6.6 deferred **personal access tokens** ("Personal-access tokens for third-party API use are deliberately post-MVP") — until then the cookie is the only credential. Monetization gives them a home: PATs are the non-cookie credential (`PUBLIC_API.CREDENTIAL`), scoped (`read`/`write`) and revocable, SHA-256-hashed like session tokens (05 §6.2), gated by the `apiAccess` entitlement (read for plus, full for pro). The full surface — endpoints exposed, rate multipliers, an OAuth-app model for third-party integrations — is an **M11** spec (`PUBLIC_API.SPEC_MILESTONE`), sketched only enough here to give the entitlement meaning.

### 6.5 Subscription vs. creator economy

- **Subscription is primary and shippable.** Plus/pro are recurring; the entitlement model above is the whole mechanism, and it is billing-provider-agnostic (the provider is a vendor pick behind a module, U14-style; no PII or card data ever touches our storage — the payment-credential prohibition holds).
- **A creator economy (payouts to popular creators) is deferred (U29).** It carries tax, payout-fraud, KYC, and content-liability weight that dwarfs the subscription model and needs real community scale to justify. The remix-lineage graph (08 §3) is the substrate a future revenue-share could attribute against, but attaching money to it is a launch+N decision, not a sketch.
- **Deliberately rejected for v1:** paywalling object/body caps (breaks §6.2), ads (hostile to a creative tool and to the low-end/`low`-tier promise), and loot-box/gacha skin mechanics (predatory; the flat skin-pack model is the honest cosmetic sale).

Concrete **prices and the exact quota boundaries** in the table are a business decision requiring market validation (**U27**) — `MONETIZATION_VERSION` gates changes to them, and none of them are load-bearing for any other document. The *architecture* — free floor pinned to shipped constants, universal invariants unsellable, additive levers — is what this milestone fixes.

---

## 7. Spike record (2026-07-22, Session 11)

Scratchpad, not committed (the S3–S10 pattern). Harness: `crdt-spike.mjs` + the real `scene.schema.json` under ajv-strict (`npm i ajv`). No Rapier this session — the determinism claim (§3) is *inherited* from S8/S10's already-proven `(document, engineVersion)` purity, not re-run; the novel risk M10 introduces is convergence + validity of the merge, which is what the spike targets.

- **A — convergence.** The add-wins-OR-map + LWW-register CRDT applied two divergent concurrent edit sessions over a 5-object base scene. **200 random delivery orders → byte-identical materialized documents; duplicate re-delivery idempotent.** Order-independence exercised, not asserted.
- **B — structural validity.** The converged document passed the real JSON Schema gate under ajv-strict. Alice's field edit + added object survived; her delete of `d2` won (no concurrent re-add); Bob's world edits + added link survived (add-wins).
- **C — the load-bearing finding.** Concurrent `{delete d2}` + `{add link L1→d2}` converges **structurally valid but with a dangling `L1→d2` reference** — a 02 §8 semantic rule the schema cannot see. The deterministic link-GC repair, run independently on a forward-order and a reverse-order replica, produced the **identical** repaired document (L1 pruned), which passes the gate with zero dangling refs. ⇒ Collaboration reuses the existing validation gate; it needs no new correctness machinery.
- **D — determinism (inherited).** The merged+repaired result is an ordinary `Scene`, so play remains a pure function of `(document, engineVersion)` — byte-identical cross-process (S8 E1) and Node≡Chromium (S10 I2).

All assertions green. The finding in C is what shaped `COLLAB.MERGE_THEN_GATE` and §2.4.

---

## 8. Decisions & open issues

### Decisions

- **D24 — Multiplayer collaboration roadmap.** Real-time co-editing is a **convergent CRDT** over the scene document (add-wins observed-remove map for objects/links + LWW registers for fields/world), synced by a **stateful collab service** that is a deliberate, contained exception to 01 §1's stateless non-goal (separate service, single-node session ownership, checkpointed to the existing `scene_revisions` store; the 05 CRUD API is unchanged). The merge is always followed by the existing 05 §5.3 validation gate — the CRDT gives structural convergence, and referential integrity is restored by a deterministic, order-independent link-GC repair — so **collaboration adds no new correctness model** (spike-validated). Play stays **local + deterministic** (edits mutate inputs only; a run is a pure function of `(document, engineVersion)`; shared *playback* is out of scope). **U13** (cross-device drafts) is the single-user degenerate case and ships as phase 1. `11-*` §2–§5, `types/monetization.ts` `COLLAB`.
- **D25 — Monetization model.** Three plans (free/plus/pro); the **free tier is pinned by construction to the shipped MVP entitlements** (compile-proven — never retroactively nerfed), paid tiers strictly additive. The **format/engine caps (object cap, body cap) are universal and unsellable** (determinism/format invariants); the sellable levers are account-scoped quotas (scene count, AI/day, collaborator seats), cosmetics (additive skin packs; the shipped 8 stay free), verification priority (changes the wait, never the result), public-API access via PATs (05 §6.6 → M11), and challenge authoring (U23, pro tier, reusing M7 moderation). **Subscription is primary; a creator payout economy is deferred (U29).** `11-*` §6, `types/monetization.ts` `PLANS`/`PUBLIC_API`.

### Open issues

- **U13 → resolved by design.** Server-side drafts / cross-device editing is subsumed by the collaboration machinery (§4.3, phase 1); implementation is post-MVP.
- **U23 → resolved by design.** User-authored challenges are a pro entitlement over the existing 08 §6 vocabulary + 08 §7 moderation (§6.3); staffing/policy is the same launch decision as U22.
- **U27 (new):** concrete prices and the exact quota boundaries in the §6.3 table need market validation → business decision, `MONETIZATION_VERSION`-gated; not load-bearing for any other doc.
- **U28 (new):** the collaboration **sync-service spec** — realtime transport (WebSocket vs. WebRTC), socket auth, reconnection/GC-repair timing, checkpoint cadence, the invite/role permission model, and multi-node session ownership beyond the v1 single-node simplification → a dedicated post-M11 milestone.
- **U29 (new):** the **creator payout economy** (revenue share attributed over remix lineage) — tax/KYC/payout-fraud/content-liability weight; needs community scale → launch+N.
- Carried unchanged: U7/U10/U12/U16/U17/U18/U20/U25/U26 (first implementation / re-measure), U11 (art pass), U14 (vendor picks), U19/U21/U24 (post-launch tuning), U22 (moderation staffing).

**Next milestone: M11 — Final roadmap MVP → production.** Consolidated development roadmap + task breakdown across all 13 brief deliverables: sequence the packages of the 01 §5 planned layout (scene-format → engine → procgen → app/api → community → collab), fold every carried U-issue into a phase (spike-confirmed vs. first-implementation vs. post-launch), turn the milestone specs (M0–M10) into an ordered build plan with the determinism/perf/verify CI gates (10 §5–6) as the definition-of-done, and place the post-MVP surfaces (collaboration phases §4.4, monetization §6, public API §6.4) on the timeline. Likely no new `types/` companion — M11 is a plan over the existing artifacts. Closes the project's design phase.

---

## 9. Changelog

- **2026-07-22 (S11):** Initial version. D24 (multiplayer collaboration roadmap — convergent CRDT + contained stateful sync service + merge-then-gate; U13 subsumed), D25 (monetization — free floor pinned to shipped MVP, unsellable invariants, additive levers; U23 folded in). Companion `types/monetization.ts`. Spike validated CRDT convergence + the merge-then-gate finding. No change to the scene format, engine constants, API, or DB schema.
