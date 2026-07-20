-- ============================================================================
-- Physics Sandbox Platform — PostgreSQL schema (M4 + M7, normative)
-- Normative source: 05-BACKEND.md §3–§4 and 08-COMMUNITY.md §3, §5–§7.
-- Target: PostgreSQL 16.
-- Machine-checked by verify-backend.mjs: parses under the real PG grammar
-- (libpg_query); table inventory, id/handle patterns, and the revision size
-- cap are cross-checked against 05-BACKEND.md and types/{api,scene}.ts.
--
-- Conventions: all timestamps timestamptz UTC; secrets stored only as
-- SHA-256 hashes (bytea, 32 bytes); soft delete via deleted_at where noted.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive handle/email
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- typo-tolerant title search
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TYPE visibility_t AS ENUM ('private', 'unlisted', 'public');
CREATE TYPE oauth_provider_t AS ENUM ('google', 'github');
CREATE TYPE auth_token_purpose_t AS ENUM ('verify_email', 'reset_password');

-- M7 (08-COMMUNITY.md). Enum label sets are cross-checked against
-- types/community.ts by verify-backend.mjs — a label added on one side only
-- fails the suite.
CREATE TYPE verification_state_t AS ENUM ('pending', 'verified', 'unranked', 'failed');
CREATE TYPE challenge_state_t AS ENUM ('draft', 'open', 'judging', 'closed');
CREATE TYPE challenge_metric_t AS ENUM (
  'durationS', 'objectsActivated', 'chainReactions',
  'longestChain', 'maxSpeedMS', 'efficiencyScore'
);
CREATE TYPE moderation_state_t AS ENUM ('visible', 'limited', 'removed');
CREATE TYPE report_target_t AS ENUM ('scene', 'comment', 'user');
CREATE TYPE report_reason_t AS ENUM (
  'spam', 'harassment', 'sexual', 'violence', 'illegal', 'impersonation', 'other'
);
CREATE TYPE report_state_t AS ENUM ('open', 'actioned', 'dismissed');

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- users — accounts (05 §6.1). password_hash NULL = OAuth-only account.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citext '~' is case-insensitive, so the pattern CHECK casts to text
  handle            citext      NOT NULL UNIQUE
                                CHECK (handle::text ~ '^[a-z0-9_]{3,20}$'),
  display_name      text        NOT NULL
                                CHECK (char_length(display_name) BETWEEN 1 AND 40),
  email             citext      NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash     text,       -- argon2id encoded string (05 §6.1)
  avatar_url        text,
  bio               text        CHECK (bio IS NULL OR char_length(bio) <= 500),
  handle_changed_at timestamptz,          -- app rule: one change per 30 d
  -- M7 (08 §2.4, §7.3): counter caches + moderation. 'limited' = delisted
  -- everywhere but direct links; 'removed' = suspended.
  follower_count    int         NOT NULL DEFAULT 0 CHECK (follower_count >= 0),
  following_count   int         NOT NULL DEFAULT 0 CHECK (following_count >= 0),
  moderation_state  moderation_state_t NOT NULL DEFAULT 'visible',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz           -- soft delete; purge job hard-deletes
);

-- ----------------------------------------------------------------------------
-- user_identities — linked OAuth identities (05 §6.3)
-- ----------------------------------------------------------------------------
CREATE TABLE user_identities (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          oauth_provider_t NOT NULL,
  provider_user_id  text        NOT NULL,
  email_at_provider citext,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_identities_user ON user_identities (user_id);

-- ----------------------------------------------------------------------------
-- auth_tokens — single-use email tokens (05 §6.4): verify 24 h, reset 1 h
-- ----------------------------------------------------------------------------
CREATE TABLE auth_tokens (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     auth_token_purpose_t NOT NULL,
  token_hash  bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id, purpose);
CREATE INDEX idx_auth_tokens_expiry ON auth_tokens (expires_at);

-- ----------------------------------------------------------------------------
-- sessions — server-side sessions (05 §6.2); cookie holds the raw token,
-- the row holds only its SHA-256. Sliding 30 d, absolute 180 d (app-enforced).
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  token_hash   bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,   -- absolute cap
  user_agent   text,
  ip           inet                    -- stored truncated (privacy, 05 §6.2)
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ----------------------------------------------------------------------------
-- scenes — metadata only; the document lives in scene_revisions (D10).
-- title/description/tags/duration_hint are extracted from doc.meta on every
-- save (05 §3.3); duration_s is advisory client-reported display data.
-- ----------------------------------------------------------------------------
CREATE TABLE scenes (
  id             text        PRIMARY KEY CHECK (id ~ '^[0-9A-Za-z]{12}$'),
  owner_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title          text        NOT NULL DEFAULT 'Untitled'
                             CHECK (char_length(title) BETWEEN 1 AND 80),
  description    text        NOT NULL DEFAULT ''
                             CHECK (char_length(description) <= 500),
  tags           text[]      NOT NULL DEFAULT '{}'
                             CHECK (cardinality(tags) <= 10),
  duration_hint  real        CHECK (duration_hint BETWEEN 1 AND 600),
  duration_s     real        CHECK (duration_s > 0 AND duration_s <= 600),
  visibility     visibility_t NOT NULL DEFAULT 'private',
  head_rev       int         NOT NULL CHECK (head_rev >= 1),
  published_rev  int         CHECK (published_rev >= 1),
  published_at   timestamptz,
  remixed_from   text        REFERENCES scenes (id) ON DELETE SET NULL,
  remix_count    int         NOT NULL DEFAULT 0 CHECK (remix_count >= 0),
  like_count     int         NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  comment_count  int         NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  thumb_key      text,       -- object-storage key, content-addressed (05 §5.4)
  -- M7 (08 §4, §7.3): ranking cache + moderation. rank_score is the trending
  -- job's last output (Redis zsets are the hot read; this survives restarts).
  rank_score     real        NOT NULL DEFAULT 0,
  ranked_at      timestamptz,
  moderation_state moderation_state_t NOT NULL DEFAULT 'visible',
  moderated_at   timestamptz,
  moderation_reason text,
  schema_version int         NOT NULL CHECK (schema_version >= 1),  -- of head
  engine_version text        NOT NULL                               -- of head
                             CHECK (engine_version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  size_bytes     int         NOT NULL,                              -- of head doc
  search_tsv     tsvector    GENERATED ALWAYS AS
                             (to_tsvector('simple', title || ' ' || description)) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,            -- trash; purge after 30 d (05 §4.1)
  -- FSM invariant (05 §4.1): anything visible has a pinned published revision
  CONSTRAINT scenes_published_when_visible
    CHECK (visibility = 'private' OR published_rev IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- scene_revisions — immutable per-save documents (D11). size_bytes mirrors
-- LIMITS.maxJsonBytes = 1000000 (types/scene.ts; cross-checked by verifier).
-- ----------------------------------------------------------------------------
CREATE TABLE scene_revisions (
  scene_id       text        NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  rev            int         NOT NULL CHECK (rev >= 1),
  doc            jsonb       NOT NULL,
  -- M7 (08 §5.4): SHA-256 of the canonical serialization (02 §2 strict writer).
  -- Verification results are keyed by this, so identical documents — remixes
  -- that changed nothing, re-saves, procgen reruns — verify exactly once.
  doc_hash       bytea       NOT NULL CHECK (octet_length(doc_hash) = 32),
  schema_version int         NOT NULL CHECK (schema_version >= 1),
  engine_version text        NOT NULL
                             CHECK (engine_version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  size_bytes     int         NOT NULL CHECK (size_bytes BETWEEN 1 AND 1000000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scene_id, rev)
);

-- Head/published pointers are real FKs (deferred: scene + first revision are
-- inserted in one transaction). Default NO ACTION means the prune job can
-- never delete a head or published revision — the FK refuses (05 §3.2).
ALTER TABLE scenes
  ADD CONSTRAINT scenes_head_rev_fk
    FOREIGN KEY (id, head_rev) REFERENCES scene_revisions (scene_id, rev)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT scenes_published_rev_fk
    FOREIGN KEY (id, published_rev) REFERENCES scene_revisions (scene_id, rev)
    DEFERRABLE INITIALLY DEFERRED;

-- Listing/search indexes (05 §3.3, §5.5) — none of these touch doc pages
CREATE INDEX idx_scenes_owner ON scenes (owner_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_scenes_public_listing ON scenes (published_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX idx_scenes_remixed_from ON scenes (remixed_from)
  WHERE remixed_from IS NOT NULL;
CREATE INDEX idx_scenes_tags ON scenes USING gin (tags);
CREATE INDEX idx_scenes_search ON scenes USING gin (search_tsv);
CREATE INDEX idx_scenes_title_trgm ON scenes USING gin (title gin_trgm_ops);
-- M7 listing paths: trending/top cold reads and the verification-cache lookup
CREATE INDEX idx_scenes_rank ON scenes (rank_score DESC, published_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL AND moderation_state = 'visible';
CREATE INDEX idx_revisions_doc_hash ON scene_revisions (doc_hash);

-- ----------------------------------------------------------------------------
-- Social tables — M7-shaped now, endpoint-less until M7 (05 §3.4).
-- Counter caches on scenes are transactional + nightly-reconciled (05 §9).
-- ----------------------------------------------------------------------------
CREATE TABLE likes (
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scene_id   text        NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scene_id)
);

CREATE INDEX idx_likes_scene ON likes (scene_id, created_at DESC);

CREATE TABLE comments (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scene_id   text        NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- M7: flat threads in v1 (08 §2.3). 'limited' is meaningless for a comment —
  -- there is nothing to delist it from — so the DDL forbids it.
  moderation_state moderation_state_t NOT NULL DEFAULT 'visible'
                   CHECK (moderation_state <> 'limited')
);

CREATE INDEX idx_comments_scene ON comments (scene_id, created_at DESC);

CREATE TABLE follows (
  follower_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
);

CREATE INDEX idx_follows_followee ON follows (followee_id);

-- ----------------------------------------------------------------------------
-- M7 — verification, challenges, moderation (08-COMMUNITY.md §5–§7)
-- ----------------------------------------------------------------------------

-- scene_verifications — the server's own headless SimCore run (08 §5). A run is
-- a pure function of (document, engineVersion, verifierVersion), so this table
-- is a permanent cache: one row per distinct triple, shared by every scene,
-- revision, remix, and challenge entry that resolves to the same document.
-- Nothing here is client-supplied; `metrics` is an AnalyticsReport (03 §10).
CREATE TABLE scene_verifications (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_hash         bytea       NOT NULL CHECK (octet_length(doc_hash) = 32),
  engine_version   text        NOT NULL
                               CHECK (engine_version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  verifier_version text        NOT NULL,
  state            verification_state_t NOT NULL DEFAULT 'pending',
  metrics          jsonb,      -- AnalyticsReport; NULL unless state = 'verified'
  final_hash       text        CHECK (final_hash ~ '^[0-9a-f]{8}$'),  -- 03 §12
  bodies           int         CHECK (bodies >= 0),
  steps            int         CHECK (steps >= 0),
  wall_ms          int         CHECK (wall_ms >= 0),
  reason           text,       -- why unranked/failed (shown to the owner)
  created_at       timestamptz NOT NULL DEFAULT now(),
  verified_at      timestamptz,
  UNIQUE (doc_hash, engine_version, verifier_version),
  -- A verified row must carry its numbers; an unverified one must not pretend to
  CONSTRAINT verification_metrics_iff_verified
    CHECK ((state = 'verified') = (metrics IS NOT NULL AND final_hash IS NOT NULL))
);

CREATE INDEX idx_verifications_pending ON scene_verifications (created_at)
  WHERE state = 'pending';

-- run_reports — advisory client telemetry (08 §5.6). Never an input to ranking;
-- the only question it answers is whether a real browser reproduced the
-- verifier's hash, which is the standing cross-platform determinism signal (U9).
CREATE TABLE run_reports (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scene_id       text        NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  user_id        uuid        REFERENCES users (id) ON DELETE SET NULL,  -- anon ok
  engine_version text        NOT NULL,
  client_hash    text        NOT NULL CHECK (client_hash ~ '^[0-9a-f]{8}$'),
  server_hash    text        CHECK (server_hash ~ '^[0-9a-f]{8}$'),
  agreement      text        NOT NULL CHECK (agreement IN ('match', 'mismatch', 'unknown')),
  platform       text        NOT NULL CHECK (char_length(platform) <= 64),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_reports_divergence ON run_reports (engine_version, created_at DESC)
  WHERE agreement = 'mismatch';

-- challenges — a brief, a machine-checkable rule set, and one ranking metric.
-- `rules` is a ChallengeRule[] (types/community.ts); its cardinality CHECK
-- mirrors CHALLENGE.MAX_RULES. Authored by staff in v1 (08 §6.1).
CREATE TABLE challenges (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           citext      NOT NULL UNIQUE
                             CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  title          text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  brief          text        NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 2000),
  state          challenge_state_t NOT NULL DEFAULT 'draft',
  rules          jsonb       NOT NULL DEFAULT '[]'
                             CHECK (jsonb_typeof(rules) = 'array'
                                    AND jsonb_array_length(rules) <= 12),
  metric         challenge_metric_t NOT NULL,
  -- Entries are comparable only within one engine build (01 §6, 08 §6.4)
  engine_version text        NOT NULL
                             CHECK (engine_version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  start_scene_id text        REFERENCES scenes (id) ON DELETE SET NULL,
  created_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  opens_at       timestamptz NOT NULL,
  closes_at      timestamptz NOT NULL,
  entry_count    int         NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_window CHECK (closes_at > opens_at)
);

CREATE INDEX idx_challenges_open ON challenges (closes_at) WHERE state = 'open';

-- challenge_entries — one scene revision entered by one user. The PK pins the
-- scene, the UNIQUE pins one entry per user (CHALLENGE.MAX_ENTRIES_PER_USER);
-- `rev` freezes the entered revision so later edits cannot move a ranking.
-- `score` is copied from the verification's metric — never from a client.
CREATE TABLE challenge_entries (
  challenge_id    bigint      NOT NULL REFERENCES challenges (id) ON DELETE CASCADE,
  scene_id        text        NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rev             int         NOT NULL CHECK (rev >= 1),
  verification_id bigint      REFERENCES scene_verifications (id) ON DELETE SET NULL,
  state           verification_state_t NOT NULL DEFAULT 'pending',
  score           double precision,
  disqualified    jsonb,      -- ApiFinding[] when verified rules failed (08 §6.3)
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  PRIMARY KEY (challenge_id, scene_id),
  UNIQUE (challenge_id, user_id),
  FOREIGN KEY (scene_id, rev) REFERENCES scene_revisions (scene_id, rev),
  -- Ranked entries carry a score; unranked/failed/disqualified ones never do
  CONSTRAINT entry_score_iff_verified
    CHECK ((state = 'verified' AND disqualified IS NULL) = (score IS NOT NULL))
);

CREATE INDEX idx_entries_board ON challenge_entries (challenge_id, score)
  WHERE state = 'verified' AND disqualified IS NULL;
CREATE INDEX idx_entries_user ON challenge_entries (user_id);

-- content_reports — the user-facing abuse channel (08 §7.2). Exactly one target
-- column is populated, enforced against target_type; NULLS NOT DISTINCT (PG 15+)
-- makes the UNIQUE bite for the two NULL columns, so one user cannot pile
-- duplicate reports on the same target.
CREATE TABLE content_reports (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_type       report_target_t NOT NULL,
  target_scene_id   text        REFERENCES scenes (id) ON DELETE CASCADE,
  target_comment_id bigint      REFERENCES comments (id) ON DELETE CASCADE,
  target_user_id    uuid        REFERENCES users (id) ON DELETE CASCADE,
  reporter_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason            report_reason_t NOT NULL,
  note              text        CHECK (note IS NULL OR char_length(note) <= 500),
  state             report_state_t NOT NULL DEFAULT 'open',
  resolved_by       uuid        REFERENCES users (id) ON DELETE SET NULL,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_one_target CHECK (
    (target_type = 'scene'   AND target_scene_id IS NOT NULL
       AND target_comment_id IS NULL AND target_user_id IS NULL) OR
    (target_type = 'comment' AND target_comment_id IS NOT NULL
       AND target_scene_id IS NULL AND target_user_id IS NULL) OR
    (target_type = 'user'    AND target_user_id IS NOT NULL
       AND target_scene_id IS NULL AND target_comment_id IS NULL)
  ),
  UNIQUE NULLS NOT DISTINCT
    (reporter_id, target_type, target_scene_id, target_comment_id, target_user_id)
);

CREATE INDEX idx_reports_queue ON content_reports (created_at) WHERE state = 'open';

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_scenes_touch BEFORE UPDATE ON scenes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_challenges_touch BEFORE UPDATE ON challenges
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE scene_revisions IS
  'Immutable scene documents, one row per explicit save (D11). Prune job keeps '
  'newest 20 per scene; head/published rows are FK-protected from pruning.';
COMMENT ON COLUMN scenes.duration_s IS
  'Advisory last-run duration reported by the client at publish (04 §11.3 card '
  'badge fallback). Display only — never ranking or leaderboard input (R2).';
COMMENT ON TABLE scene_verifications IS
  'Server-computed run results (08 §5, D17). Keyed by (doc_hash, engine_version, '
  'verifier_version) because a run is a pure function of the document — this is '
  'the whole anti-cheat argument: leaderboard values are recomputed, not trusted.';
COMMENT ON TABLE run_reports IS
  'Client-reported analytics, advisory only (08 §5.6). Feeds the U9 '
  'cross-platform determinism dashboard; never ranking.';
