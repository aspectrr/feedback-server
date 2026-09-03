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

export const SEVERITIES = new Set(["info", "warning", "error", "suggestion"]);
export const SCREENSHOT_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const TOKEN_TTL_MS = 10 * 60_000;

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
