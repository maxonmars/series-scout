import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/adapters/sqlite/database.ts";
import { createSqliteStore, type SqliteStore } from "../../src/adapters/sqlite/store.ts";

export type TestDatabase = {
  readonly path: string;
  db: DatabaseSync;
  store: SqliteStore;
  readonly reopen: () => void;
  readonly cleanup: () => void;
};

/** Временная база в отдельном каталоге; `reopen` имитирует перезапуск процесса. */
export function createTestDatabase(clock: () => number = () => 1_000): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), "series-scout-db-"));
  const path = join(dir, "series-scout.db");
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const db = openDatabase(path);
  const handle: TestDatabase = {
    path,
    db,
    store: createSqliteStore(db, clock, newId),
    reopen() {
      handle.db.close();
      handle.db = openDatabase(path);
      handle.store = createSqliteStore(handle.db, clock, newId);
    },
    cleanup() {
      if (handle.db.isOpen) handle.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}
