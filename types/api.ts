/**
 * Backend API — TypeScript definitions.
 *
 * Normative sources: 05-BACKEND.md and openapi.yaml. This file mirrors them
 * for compile-time safety in the Fastify app and the web client's API layer,
 * and is the machine half of several 05 rules:
 *
 *  - `ApiErrorCode` is a strict superset of the worker's `SimErrorCode`
 *    (05 §5.2) — enforced below at the type level.
 *  - `ROUTES` must equal openapi.yaml's operation set (id, method, path) —
 *    enforced by verify-backend.mjs.
 *  - Thumbnail dimensions must equal the builder's render size
 *    (types/editor.ts EDITOR.THUMB_W/H, 04 §11.2) — enforced below.
 *
 * DTO field semantics (what "rev" means per context, access rules, FSM) live
 * in 05-BACKEND.md §4–§5; nothing here invents behavior.
 */

import type { Id, Scene } from './scene';
import { LIMITS } from './scene';
import type { SimErrorCode } from './protocol';
import { EDITOR } from './editor';

export const API_VERSION = 1 as const;
/** The version segment lives in the server URL (05 §5.1). */
export const API_BASE_PATH = '/v1' as const;

// ---------------------------------------------------------------------------
// Error model (05 §5.2) — one envelope, aligned with the worker codes
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_CREDENTIALS'
  | 'E_AUTH_REQUIRED'
  | 'E_EMAIL_UNVERIFIED'
  | 'E_FORBIDDEN'
  | 'E_QUOTA'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_REV_MISMATCH'
  | 'E_TOO_LARGE'
  | 'E_UNSUPPORTED_MEDIA'
  | 'E_SCHEMA'
  | 'E_SEMANTIC'
  | 'E_LIMITS'
  | 'E_SCHEMA_NEWER'
  | 'E_IF_MATCH_REQUIRED'
  | 'E_RATE_LIMITED'
  | 'E_AI_BUDGET'
  | 'E_INTERNAL'
  | 'E_AI_UNAVAILABLE';

/**
 * Compile-time proof that every worker error code is a valid API code, so the
 * 04 §8.6 copy table needs no remapping layer (05 §5.2).
 */
type SimCodesAreApiCodes = SimErrorCode extends ApiErrorCode ? true : never;
export const SIM_CODES_ARE_API_CODES: SimCodesAreApiCodes = true;

/** HTTP status per code — must match the 05 §5.2 table (verified). */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  E_BAD_REQUEST: 400,
  E_CREDENTIALS: 401,
  E_AUTH_REQUIRED: 401,
  E_EMAIL_UNVERIFIED: 403,
  E_FORBIDDEN: 403,
  E_QUOTA: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_REV_MISMATCH: 412,
  E_TOO_LARGE: 413,
  E_UNSUPPORTED_MEDIA: 415,
  E_SCHEMA: 422,
  E_SEMANTIC: 422,
  E_LIMITS: 422,
  E_SCHEMA_NEWER: 422,
  E_IF_MATCH_REQUIRED: 428,
  E_RATE_LIMITED: 429,
  E_AI_BUDGET: 429,
  E_INTERNAL: 500,
  E_AI_UNAVAILABLE: 503,
} as const;

/** One validation-gate finding — the shape the builder panel consumes (04 §8.5). */
export interface ApiFinding {
  /** "schema" or a 02 §8 rule id: E1–E8, W9–W12. */
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  /** JSON pointer into the document, when locatable. */
  path?: string;
  /** Offending object/link ids, when known (jump-to-offender). */
  ids?: Id[];
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Code-specific; for the four validation codes: { findings }. */
    details?: { findings?: ApiFinding[] } & Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Constants (05 §3, §5, §6, §8) — single source for server + client
// ---------------------------------------------------------------------------

export const API = {
  /** Share/scene id: 12 chars, ≈71.4 bits — the /s/{id} capability (05 §3.1). */
  SCENE_ID_LEN: 12,
  SCENE_ID_PATTERN: /^[0-9A-Za-z]{12}$/,
  /** Public profile handle (citext-unique in the DB). */
  HANDLE_PATTERN: /^[a-z0-9_]{3,20}$/,
  HANDLE_CHANGE_COOLDOWN_DAYS: 30,
  /**
   * Transport body cap, above the 1 MB document cap so the gate can diagnose
   * oversized docs with E_LIMITS instead of a connection drop (05 §5.3).
   */
  JSON_BODY_CAP_BYTES: 1_048_576,
  /** Client-rendered thumbnail (04 §11.2): exact dims, webp only. */
  THUMB: { w: 640, h: 360, maxBytes: 131_072, mime: 'image/webp' },
  /** Non-trashed scenes per account → E_QUOTA (05 §8). */
  MAX_ACTIVE_SCENES: 500,
  /** Revisions kept per scene by the prune job; head/published FK-protected (05 §3.2). */
  REVISION_KEEP: 20,
  /** Days in trash before the purge job hard-deletes (05 §4.1). */
  TRASH_TTL_DAYS: 30,
  /** Keyset pagination (05 §5.1). */
  PAGE_DEFAULT: 24,
  PAGE_MAX: 50,
} as const;

/** Thumbnail dims must equal the builder's render size — compile-time tie. */
const _thumbW: typeof EDITOR.THUMB_W = API.THUMB.w;
const _thumbH: typeof EDITOR.THUMB_H = API.THUMB.h;
void _thumbW;
void _thumbH;

/** The transport cap must clear the document cap (05 §5.3); numeric check in verify-backend.mjs. */
export const DOC_CAP_BYTES: typeof LIMITS.maxJsonBytes = LIMITS.maxJsonBytes;

export const AUTH = {
  /** __Host- prefix: Secure, Path=/, no Domain — pinned to the API origin (05 §6.2). */
  SESSION_COOKIE: '__Host-ps_sess',
  SESSION_TOKEN_BYTES: 32,
  SESSION_SLIDING_DAYS: 30,
  SESSION_ABSOLUTE_DAYS: 180,
  /** Redis read-through TTL; logout paths delete explicitly (05 §6.2). */
  SESSION_CACHE_TTL_S: 300,
  /** argon2id (05 §6.1) — OWASP-level; login rate limits are sized against it. */
  ARGON2: { memMiB: 64, iterations: 3, parallelism: 1 },
  VERIFY_EMAIL_TTL_H: 24,
  RESET_PASSWORD_TTL_H: 1,
  OAUTH_PROVIDERS: ['google', 'github'],
} as const;

/** Handles that can never be registered (route/namespace collisions, 05 §3.1). */
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'api',
  'auth',
  'build',
  'explore',
  'healthz',
  'help',
  'me',
  'moderator',
  'official',
  'root',
  's',
  'scenes',
  'settings',
  'staff',
  'support',
  'system',
  'users',
] as const;

/**
 * Rate buckets (05 §8): Redis token buckets, 429 + Retry-After on exhaustion.
 * M7 social buckets are reserved now so abuse posture precedes the features.
 */
export interface RateBucket {
  per: 'ip' | 'account' | 'user';
  limit: number;
  windowS: number;
}

export const RATE_LIMITS: Record<string, RateBucket> = {
  publicRead: { per: 'ip', limit: 300, windowS: 60 },
  login: { per: 'ip', limit: 10, windowS: 900 },
  loginAccount: { per: 'account', limit: 10, windowS: 3600 },
  register: { per: 'ip', limit: 5, windowS: 3600 },
  emailToken: { per: 'ip', limit: 5, windowS: 3600 },
  emailTokenAccount: { per: 'account', limit: 3, windowS: 86_400 },
  sceneCreateHour: { per: 'user', limit: 30, windowS: 3600 },
  sceneCreateDay: { per: 'user', limit: 200, windowS: 86_400 },
  sceneSave: { per: 'user', limit: 60, windowS: 600 },
  sceneDelete: { per: 'user', limit: 60, windowS: 86_400 },
  publish: { per: 'user', limit: 30, windowS: 86_400 },
  remix: { per: 'user', limit: 60, windowS: 86_400 },
  thumbnail: { per: 'user', limit: 60, windowS: 86_400 },
  // M6 AI generation (07 §7.3). aiCallsDay counts MODEL CALLS (generate +
  // repair each debit one); exhaustion is E_AI_BUDGET, not E_RATE_LIMITED.
  // Must satisfy aiCallsDay.limit ≥ 1 + AI.REPAIR_ROUNDS_MAX (verify-backend).
  aiBurst: { per: 'user', limit: 3, windowS: 60 },
  aiCallsDay: { per: 'user', limit: 20, windowS: 86_400 },
  // Reserved for M7 (no endpoints yet):
  like: { per: 'user', limit: 500, windowS: 86_400 },
  comment: { per: 'user', limit: 100, windowS: 86_400 },
  follow: { per: 'user', limit: 200, windowS: 86_400 },
} as const;

// ---------------------------------------------------------------------------
// DTOs (mirror openapi.yaml components/schemas)
// ---------------------------------------------------------------------------

export type Visibility = 'private' | 'unlisted' | 'public';
export type OauthProvider = 'google' | 'github';

export interface UserRefDto {
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

export interface MeDto {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  /** false ⇒ publish returns E_EMAIL_UNVERIFIED (05 §6.4). */
  emailVerified: boolean;
  avatarUrl?: string;
  createdAt: string;
}

export interface UserProfileDto {
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  /** Public scenes. */
  sceneCount: number;
  createdAt: string;
}

/**
 * Scene metadata, no document. `rev` = the revision this response corresponds
 * to: head for owner reads, published otherwise (05 §4.2).
 */
export interface SceneDto {
  id: string;
  owner: UserRefDto;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  rev: number;
  publishedRev?: number;
  publishedAt?: string;
  /** Card badge value: coalesce(meta.durationHint, advisory last run) (05 §3.3). */
  durationS?: number;
  remixedFrom?: string;
  remixCount: number;
  likeCount: number;
  commentCount: number;
  thumbnailUrl?: string;
  schemaVersion: number;
  engineVersion: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** Gallery card — exactly the 04 §11.3 contract. */
export interface SceneCardDto {
  id: string;
  title: string;
  author: UserRefDto;
  thumbnailUrl?: string;
  likeCount: number;
  durationS?: number;
  remixedFrom?: string;
  publishedAt: string;
}

export interface SceneWithDocResponse {
  scene: SceneDto;
  /** The scene document itself — typed by the shared format (ADR-0004). */
  doc: Scene;
}

export interface SceneWriteResponse {
  scene: SceneDto;
  /** 02 §8 W-rules; never blocking (05 §5.1). */
  warnings: ApiFinding[];
}

export interface ThumbnailResponse {
  thumbnailUrl: string;
}

export interface Page<T> {
  items: T[];
  /** Absent on the last page. */
  nextCursor?: string;
}

// Requests -------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  password: string;
  handle: string;
  /** Defaults to the handle. */
  displayName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TokenRequest {
  token: string;
}

export interface PasswordResetConfirmRequest {
  token: string;
  newPassword: string;
}

export interface CreateSceneRequest {
  doc: Scene;
}

export interface SaveSceneRequest {
  doc: Scene;
}

export interface PublishRequest {
  visibility: Exclude<Visibility, 'private'>;
  /** Advisory (03 §10 durationS); display only, never ranking (05 §3.3). */
  durationS?: number;
}

// ---------------------------------------------------------------------------
// Route table — must equal openapi.yaml's operations (verify-backend.mjs)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * none = anonymous ok · session = signed in · owner = session + owns the
 * resource · verified = owner + verified email (05 §5.1). Enforcement beyond
 * `session` is in handlers (ownership is data-dependent).
 */
export type AuthLevel = 'none' | 'session' | 'owner' | 'verified';

export interface RouteDef {
  method: HttpMethod;
  path: string;
  auth: AuthLevel;
}

// One line per route — verify-backend.mjs parses these lines textually.
export const ROUTES: Record<string, RouteDef> = {
  healthCheck: { method: 'GET', path: '/healthz', auth: 'none' },
  registerUser: { method: 'POST', path: '/auth/register', auth: 'none' },
  loginUser: { method: 'POST', path: '/auth/login', auth: 'none' },
  logoutUser: { method: 'POST', path: '/auth/logout', auth: 'session' },
  logoutAllSessions: { method: 'POST', path: '/auth/logout-all', auth: 'session' },
  getMe: { method: 'GET', path: '/me', auth: 'session' },
  verifyEmail: { method: 'POST', path: '/auth/verify-email', auth: 'none' },
  resendVerification: { method: 'POST', path: '/auth/resend-verification', auth: 'session' },
  requestPasswordReset: { method: 'POST', path: '/auth/password-reset/request', auth: 'none' },
  confirmPasswordReset: { method: 'POST', path: '/auth/password-reset/confirm', auth: 'none' },
  startOauth: { method: 'GET', path: '/auth/oauth/{provider}/start', auth: 'none' },
  oauthCallback: { method: 'GET', path: '/auth/oauth/{provider}/callback', auth: 'none' },
  createScene: { method: 'POST', path: '/scenes', auth: 'session' },
  getScene: { method: 'GET', path: '/scenes/{sceneId}', auth: 'none' },
  saveScene: { method: 'PUT', path: '/scenes/{sceneId}', auth: 'owner' },
  deleteScene: { method: 'DELETE', path: '/scenes/{sceneId}', auth: 'owner' },
  restoreScene: { method: 'POST', path: '/scenes/{sceneId}/restore', auth: 'owner' },
  publishScene: { method: 'POST', path: '/scenes/{sceneId}/publish', auth: 'verified' },
  unpublishScene: { method: 'POST', path: '/scenes/{sceneId}/unpublish', auth: 'owner' },
  remixScene: { method: 'POST', path: '/scenes/{sceneId}/remix', auth: 'session' },
  uploadThumbnail: { method: 'PUT', path: '/scenes/{sceneId}/thumbnail', auth: 'owner' },
  listMyScenes: { method: 'GET', path: '/me/scenes', auth: 'session' },
  aiGenerate: { method: 'POST', path: '/ai/generate', auth: 'session' },
  aiRepair: { method: 'POST', path: '/ai/generate/{generationId}/repair', auth: 'session' },
  exploreScenes: { method: 'GET', path: '/explore', auth: 'none' },
  getUserProfile: { method: 'GET', path: '/users/{handle}', auth: 'none' },
  listUserScenes: { method: 'GET', path: '/users/{handle}/scenes', auth: 'none' },
} as const;
