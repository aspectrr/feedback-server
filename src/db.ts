import { Database } from "bun:sqlite";

// DB lives on the Fly volume in prod; local fallback for dev.
const DB_PATH =
  process.env.DB_PATH ??
  (process.env.NODE_ENV === "production" ? "/data/feedback.db" : "./feedback.db");

// Schema mirrors redline's feedback table; tool_name generalized to `source`.
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT NOT NULL,
    message     TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'info',
    rating      INTEGER,
    agent_id    TEXT,
    screenshot  BLOB,
    screenshot_mime TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(id DESC);

  CREATE TABLE IF NOT EXISTS tokens (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used        INTEGER NOT NULL DEFAULT 0
  );
`);

// Migration for DBs created before screenshots existed.
const cols = (db.query("PRAGMA table_info(feedback)").all() as { name: string }[]).map(
  (c) => c.name
);
if (!cols.includes("screenshot")) db.exec("ALTER TABLE feedback ADD COLUMN screenshot BLOB");
if (!cols.includes("screenshot_mime"))
  db.exec("ALTER TABLE feedback ADD COLUMN screenshot_mime TEXT");

export const SEVERITIES = new Set(["info", "warning", "error", "suggestion", "bug"]);
export const SCREENSHOT_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const TOKEN_TTL_MS = 10 * 60_000;

export type FeedbackEntry = {
  source: string;
  message: string;
  severity: string;
  rating: number | null;
  agent_id: string | null;
  screenshot: Buffer | null;
  screenshot_mime: string | null;
};

// Shared input shaping for POST /feedback and the MCP submit_feedback tool.
// Loose typing is deliberate: each caller pre-validates with its own schema.
export function normalizeEntry(body: Record<string, unknown>): { entry: FeedbackEntry } | { error: string; status: number } {
  const source = typeof body.source === "string" ? body.source.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!source) return { error: "source is required (skill or app name)", status: 422 };
  if (!message) return { error: "message is required", status: 422 };
  const rating =
    typeof body.rating === "number" && body.rating >= 1 && body.rating <= 5 ? Math.trunc(body.rating) : null;
  const severity =
    typeof body.severity === "string" && SEVERITIES.has(body.severity) ? body.severity : "info";
  const agent_id =
    typeof body.agent_id === "string" && body.agent_id.trim() ? body.agent_id.trim() : null;

  // ponytail: Buffer.from ignores invalid base64 chars silently; size checks are the real gate.
  let screenshot: Buffer | null = null;
  if (typeof body.screenshot === "string" && body.screenshot.length) {
    if (body.screenshot.length > (MAX_SCREENSHOT_BYTES / 3) * 4) {
      return { error: `screenshot too large (max ${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB)`, status: 413 };
    }
    screenshot = Buffer.from(body.screenshot, "base64");
    if (screenshot.length === 0 || screenshot.length > MAX_SCREENSHOT_BYTES) {
      return { error: "screenshot is empty or too large", status: 422 };
    }
  }
  const screenshot_mime =
    typeof body.screenshot_mime === "string" && SCREENSHOT_MIMES.has(body.screenshot_mime)
      ? body.screenshot_mime
      : "image/png";

  return {
    entry: {
      source,
      message,
      severity,
      rating,
      agent_id,
      screenshot,
      screenshot_mime: screenshot ? screenshot_mime : null,
    },
  };
}

export type FeedbackRow = {
  id: number;
  created_at: string;
  source: string;
  message: string;
  severity: string;
  rating: number | null;
  agent_id: string | null;
  screenshot_mime: string | null;
  has_screenshot: 0 | 1;
};

export function createToken(): string {
  cleanupTokens();
  const token = crypto.randomUUID();
  db.query("INSERT INTO tokens (token) VALUES (?)").run(token);
  return token;
}

export function getToken(token: string): { used: number; created_at: string } | null {
  return (
    (db
      .query("SELECT used, created_at FROM tokens WHERE token = ?")
      .get(token) as { used: number; created_at: string } | null) ?? null
  );
}

export function isTokenExpired(created_at: string): boolean {
  return Date.now() - new Date(created_at.replace(" ", "T") + "Z").getTime() > TOKEN_TTL_MS;
}

export function consumeToken(token: string): void {
  db.query("UPDATE tokens SET used = 1 WHERE token = ?").run(token);
}

export function cleanupTokens(): void {
  db.exec("DELETE FROM tokens WHERE created_at < datetime('now', '-1 hour')");
}

export function addFeedback(entry: {
  source: string;
  message: string;
  severity: string;
  rating: number | null;
  agent_id: string | null;
  screenshot: Buffer | null;
  screenshot_mime: string | null;
}): number {
  db.query(
    "INSERT INTO feedback (source, message, severity, rating, agent_id, screenshot, screenshot_mime) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    entry.source,
    entry.message,
    entry.severity,
    entry.rating,
    entry.agent_id,
    entry.screenshot,
    entry.screenshot_mime
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

export function getScreenshot(
  id: number
): { bytes: Buffer; mime: string | null } | null {
  const row = db
    .query("SELECT screenshot, screenshot_mime FROM feedback WHERE id = ?")
    .get(id) as { screenshot: Buffer | null; screenshot_mime: string | null } | null;
  if (!row?.screenshot) return null;
  return { bytes: row.screenshot, mime: row.screenshot_mime };
}

export function listFeedback(opts: {
  limit?: number;
  offset?: number;
  source?: string;
}): FeedbackRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const source = opts.source;

  // Explicit columns — never select the BLOB into listings.
  const cols =
    "id, created_at, source, message, severity, rating, agent_id, screenshot_mime, (screenshot IS NOT NULL) AS has_screenshot";
  return (
    source
      ? db
          .query(`SELECT ${cols} FROM feedback WHERE source = ? ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(source, limit, offset)
      : db.query(`SELECT ${cols} FROM feedback ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset)
  ) as FeedbackRow[];
}

// --- OAuth 2.1 (authorization server) ---
// Public clients (PKCE, no secret). Tokens stored as SHA-256 hashes —
// a DB leak must not yield live credentials.
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id   TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code         TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope        TEXT NOT NULL DEFAULT 'feedback',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    used         INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash  TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'feedback',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    revoked     INTEGER NOT NULL DEFAULT 0
  );
`);

export const OAUTH_ACCESS_TTL_MS = 14 * 24 * 60 * 60_000; // 14 days
export const OAUTH_REFRESH_TTL_MS = 90 * 24 * 60 * 60_000; // 90 days
export const OAUTH_CODE_TTL_MS = 120_000;


function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const tokenHash = (t: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
async function hashToken(t: string): Promise<string> {
  return Buffer.from(await tokenHash(t)).toString("hex");
}

export function createOAuthClient(client_name: string, redirect_uris: string[]): string {
  const client_id = randomToken();
  db.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)").run(
    client_id,
    client_name,
    JSON.stringify(redirect_uris)
  );
  return client_id;
}

export function getOAuthClient(client_id: string): { client_name: string; redirect_uris: string[] } | null {
  const row = db
    .query("SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .get(client_id) as { client_name: string; redirect_uris: string } | null;
  if (!row) return null;
  return { client_name: row.client_name, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

export function createAuthCode(client_id: string, redirect_uri: string, code_challenge: string, scope: string): string {
  cleanupOAuth();
  const code = randomToken();
  db.query(
    "INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scope) VALUES (?, ?, ?, ?, ?)"
  ).run(code, client_id, redirect_uri, code_challenge, scope);
  return code;
}

export function getAuthCode(
  code: string
): { client_id: string; redirect_uri: string; code_challenge: string; scope: string; used: number; created_at: string } | null {
  return (
    (db
      .query(
        "SELECT client_id, redirect_uri, code_challenge, scope, used, created_at FROM oauth_codes WHERE code = ?"
      )
      .get(code) as {
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string;
      used: number;
      created_at: string;
    } | null) ?? null
  );
}

export function consumeAuthCode(code: string): void {
  db.query("UPDATE oauth_codes SET used = 1 WHERE code = ?").run(code);
}

export async function issueTokens(
  client_id: string,
  scope: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const access = randomToken();
  const refresh = randomToken();
  db.query("INSERT INTO oauth_tokens (token_hash, type, client_id, scope) VALUES (?, 'access', ?, ?)").run(
    await hashToken(access),
    client_id,
    scope
  );
  db.query("INSERT INTO oauth_tokens (token_hash, type, client_id, scope) VALUES (?, 'refresh', ?, ?)").run(
    await hashToken(refresh),
    client_id,
    scope
  );
  return { access_token: access, refresh_token: refresh, expires_in: OAUTH_ACCESS_TTL_MS / 1000 };
}

export async function getAccessToken(token: string): Promise<boolean> {
  const row = db
    .query("SELECT type, created_at, revoked FROM oauth_tokens WHERE token_hash = ?")
    .get(await hashToken(token)) as { type: string; created_at: string; revoked: number } | null;
  return (
    row !== null &&
    row.type === "access" &&
    row.revoked === 0 &&
    Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime() < OAUTH_ACCESS_TTL_MS
  );
}

// Rotation: the presented refresh token is revoked and a fresh pair issued.
export async function rotateRefreshToken(
  refresh_token: string,
  client_id: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string } | null> {
  const row = db
    .query("SELECT type, client_id, scope, created_at, revoked FROM oauth_tokens WHERE token_hash = ?")
    .get(await hashToken(refresh_token)) as {
    type: string;
    client_id: string;
    scope: string;
    created_at: string;
    revoked: number;
  } | null;
  if (
    row === null ||
    row.type !== "refresh" ||
    row.revoked === 1 ||
    row.client_id !== client_id ||
    Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime() > OAUTH_REFRESH_TTL_MS
  ) {
    return null;
  }
  db.query("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").run(await hashToken(refresh_token));
  const fresh = await issueTokens(row.client_id, row.scope);
  return { ...fresh, scope: row.scope };
}

export function cleanupOAuth(): void {
  db.exec("DELETE FROM oauth_codes WHERE created_at < datetime('now', '-1 hour')");
  db.exec(
    `DELETE FROM oauth_tokens WHERE revoked = 1
      OR (type = 'access' AND created_at < datetime('now', '-14 days'))
      OR (type = 'refresh' AND created_at < datetime('now', '-90 days'))`
  );
}
