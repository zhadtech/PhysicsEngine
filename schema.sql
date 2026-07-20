-- ============================================================================
-- Physics Sandbox Platform — PostgreSQL schema (M4, normative)
-- Normative source: 05-BACKEND.md §3–§4. Target: PostgreSQL 16.
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
  deleted_at timestamptz
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
-- updated_at triggers
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_scenes_touch BEFORE UPDATE ON scenes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMENT ON TABLE scene_revisions IS
  'Immutable scene documents, one row per explicit save (D11). Prune job keeps '
  'newest 20 per scene; head/published rows are FK-protected from pruning.';
COMMENT ON COLUMN scenes.duration_s IS
  'Advisory last-run duration reported by the client at publish (04 §11.3 card '
  'badge fallback). Display only — never ranking or leaderboard input (R2).';
