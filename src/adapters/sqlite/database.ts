import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_V1 = `
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL
);
CREATE TABLE interview (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE dialog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE library (
  tmdb_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER,
  want_to_watch INTEGER NOT NULL CHECK (want_to_watch IN (0, 1)),
  watched INTEGER NOT NULL CHECK (watched IN (0, 1)),
  rating TEXT CHECK (rating IN ('liked', 'disliked')),
  comment TEXT,
  not_interested INTEGER NOT NULL CHECK (not_interested IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE subscriptions (
  tmdb_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE premieres (
  tmdb_id INTEGER NOT NULL REFERENCES subscriptions (tmdb_id),
  season_number INTEGER NOT NULL CHECK (season_number > 0),
  air_date TEXT,
  today_notified_on TEXT,
  PRIMARY KEY (tmdb_id, season_number)
);
CREATE TABLE calendar_events (
  tmdb_id INTEGER NOT NULL,
  season_number INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('create', 'update', 'delete', 'synced', 'deleted')),
  event_date TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, season_number)
);
CREATE TABLE recommendation_batches (
  id TEXT PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE recommendation_items (
  batch_id TEXT NOT NULL REFERENCES recommendation_batches (id),
  position INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  card TEXT NOT NULL,
  PRIMARY KEY (batch_id, position)
);
CREATE INDEX recommendation_items_tmdb ON recommendation_items (tmdb_id);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  last_error TEXT,
  UNIQUE (dedupe_key, position)
);
CREATE INDEX outbox_pending ON outbox (sent_at, next_attempt_at);
CREATE TABLE jobs (
  name TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_started_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);
CREATE TABLE service_health (
  service TEXT PRIMARY KEY,
  last_success_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);
CREATE TABLE catalog_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

export type OpenDatabaseOptions = {
  /** Монопольная блокировка файла: второй процесс с той же базой не запустится. */
  readonly exclusive?: boolean;
};

export class DatabaseLockedError extends Error {
  constructor() {
    super("База данных занята другим процессом Series Scout");
    this.name = "DatabaseLockedError";
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Монопольную блокировку держит другой процесс бессрочно: ожидание бессмысленно.
    db.exec(`PRAGMA busy_timeout = ${options.exclusive ? 0 : BUSY_TIMEOUT_MS}`);
    if (options.exclusive) db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    db.close();
    if (error instanceof Error && /database is locked/i.test(error.message)) throw new DatabaseLockedError();
    throw error;
  }
  return db;
}

function migrate(db: DatabaseSync): void {
  inTransaction(db, () => {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Схема базы (${version}) новее поддерживаемой (${SCHEMA_VERSION}): обновите приложение`);
    }
    if (version === 0) db.exec(SCHEMA_V1);
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** IMMEDIATE берёт блокировку записи сразу; транзакции не пересекают сетевые вызовы. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
