import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { ServiceName } from "../../application/errors.ts";
import type {
  CalendarStore,
  DialogStore,
  HealthStore,
  IdGenerator,
  JobRecord,
  JobStore,
  LibraryStore,
  OutboxItem,
  OutboxStore,
  OutgoingMessage,
  PendingInput,
  ProfileStore,
  RecommendationBatch,
  RecommendationStore,
  ServiceHealth,
  SubscriptionStore,
  Transactional,
} from "../../application/ports.ts";
import type { CalendarEventRecord, CalendarEventStatus } from "../../domain/calendar.ts";
import type { InterviewState } from "../../domain/interview.ts";
import type { LibraryEntry } from "../../domain/library.ts";
import type { KnownPremiere, Subscription } from "../../domain/premieres.ts";
import type { Profile, Sentiment } from "../../domain/profile.ts";
import { inTransaction } from "./database.ts";
import {
  interviewSchema,
  outgoingMessageSchema,
  parseStored,
  pendingInputSchema,
  profileSchema,
  seriesCardSchema,
} from "./schemas.ts";

type Row = Record<string, SQLOutputValue>;

const int = (row: Row, column: string): number => Number(row[column]);
const intOrNull = (row: Row, column: string): number | null => (row[column] === null ? null : Number(row[column]));
const text = (row: Row, column: string): string => String(row[column]);
const textOrNull = (row: Row, column: string): string | null => (row[column] === null ? null : String(row[column]));
const flag = (value: boolean): number => (value ? 1 : 0);

const SENTIMENTS: readonly Sentiment[] = ["liked", "disliked"];
const EVENT_STATUSES: readonly CalendarEventStatus[] = ["create", "update", "delete", "synced", "deleted"];
const SERVICES: readonly ServiceName[] = ["tmdb", "deepseek", "google", "telegram"];

function oneOf<T extends string>(values: readonly T[], raw: string | null, what: string): T {
  const found = values.find((value) => value === raw);
  if (found === undefined) throw new Error(`Повреждённая запись в базе: ${what}`);
  return found;
}

export type SqliteStore = Transactional &
  ProfileStore &
  DialogStore &
  LibraryStore &
  SubscriptionStore &
  CalendarStore &
  RecommendationStore &
  OutboxStore &
  JobStore &
  HealthStore & {
    readonly getCachedResponse: (key: string, notOlderThan: number) => string | null;
    readonly saveCachedResponse: (key: string, body: string, at: number) => void;
  };

/** Все хранилища приложения поверх одной базы; `clock` нужен только для отметок времени изменений. */
export function createSqliteStore(db: DatabaseSync, clock: () => number, newId: IdGenerator): SqliteStore {
  const run = (sql: string, params: Record<string, string | number | null> = {}) => db.prepare(sql).run(params);
  const get = (sql: string, params: Record<string, string | number | null> = {}) =>
    db.prepare(sql).get(params) as Row | undefined;
  const all = (sql: string, params: Record<string, string | number | null> = {}) =>
    db.prepare(sql).all(params) as Row[];

  const toLibraryEntry = (row: Row): LibraryEntry => ({
    tmdbId: int(row, "tmdb_id"),
    name: text(row, "name"),
    year: intOrNull(row, "year"),
    wantToWatch: int(row, "want_to_watch") === 1,
    watched: int(row, "watched") === 1,
    rating: row.rating === null ? null : oneOf(SENTIMENTS, textOrNull(row, "rating"), "library.rating"),
    comment: textOrNull(row, "comment"),
    notInterested: int(row, "not_interested") === 1,
  });

  const toSubscription = (row: Row): Subscription => ({
    tmdbId: int(row, "tmdb_id"),
    name: text(row, "name"),
    year: intOrNull(row, "year"),
    active: int(row, "active") === 1,
  });

  const toCalendarEvent = (row: Row): CalendarEventRecord => ({
    tmdbId: int(row, "tmdb_id"),
    seasonNumber: int(row, "season_number"),
    generation: int(row, "generation"),
    eventId: text(row, "event_id"),
    status: oneOf(EVENT_STATUSES, textOrNull(row, "status"), "calendar_events.status"),
    date: text(row, "event_date"),
  });

  const toJob = (row: Row): JobRecord => ({
    name: text(row, "name"),
    schedule: text(row, "schedule"),
    nextRunAt: int(row, "next_run_at"),
    lastStartedAt: intOrNull(row, "last_started_at"),
    lastSuccessAt: intOrNull(row, "last_success_at"),
    lastError: textOrNull(row, "last_error"),
    lastErrorAt: intOrNull(row, "last_error_at"),
  });

  const transaction = <T>(work: () => T): T => inTransaction(db, work);

  return {
    transaction,

    getProfile(): Profile | null {
      const row = get("SELECT data FROM profile WHERE id = 1");
      return row ? parseStored(profileSchema, row.data, "profile") : null;
    },
    getInterview(): InterviewState | null {
      const row = get("SELECT data FROM interview WHERE id = 1");
      return row ? parseStored(interviewSchema, row.data, "interview") : null;
    },
    saveInterview(state) {
      run(
        `INSERT INTO interview (id, data, updated_at) VALUES (1, :data, :now)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        { data: JSON.stringify(state), now: clock() },
      );
    },
    deleteInterview() {
      run("DELETE FROM interview WHERE id = 1");
    },
    confirmProfile(profile) {
      transaction(() => {
        run(
          `INSERT INTO profile (id, data, confirmed_at) VALUES (1, :data, :now)
           ON CONFLICT (id) DO UPDATE SET data = excluded.data, confirmed_at = excluded.confirmed_at`,
          { data: JSON.stringify(profile), now: clock() },
        );
        run("DELETE FROM interview WHERE id = 1");
      });
    },

    getPendingInput(): PendingInput | null {
      const row = get("SELECT data FROM dialog WHERE id = 1");
      return row ? parseStored(pendingInputSchema, row.data, "dialog") : null;
    },
    setPendingInput(input) {
      if (input === null) {
        run("DELETE FROM dialog WHERE id = 1");
        return;
      }
      run("INSERT INTO dialog (id, data) VALUES (1, :data) ON CONFLICT (id) DO UPDATE SET data = excluded.data", {
        data: JSON.stringify(input),
      });
    },

    getEntry(tmdbId) {
      const row = get("SELECT * FROM library WHERE tmdb_id = :tmdbId", { tmdbId });
      return row ? toLibraryEntry(row) : null;
    },
    saveEntry(entry) {
      run(
        `INSERT INTO library (tmdb_id, name, year, want_to_watch, watched, rating, comment, not_interested, updated_at)
         VALUES (:tmdbId, :name, :year, :wantToWatch, :watched, :rating, :comment, :notInterested, :now)
         ON CONFLICT (tmdb_id) DO UPDATE SET
           name = excluded.name, year = excluded.year, want_to_watch = excluded.want_to_watch,
           watched = excluded.watched, rating = excluded.rating, comment = excluded.comment,
           not_interested = excluded.not_interested, updated_at = excluded.updated_at`,
        {
          tmdbId: entry.tmdbId,
          name: entry.name,
          year: entry.year,
          wantToWatch: flag(entry.wantToWatch),
          watched: flag(entry.watched),
          rating: entry.rating,
          comment: entry.comment,
          notInterested: flag(entry.notInterested),
          now: clock(),
        },
      );
    },
    listEntries() {
      return all("SELECT * FROM library ORDER BY updated_at DESC, tmdb_id").map(toLibraryEntry);
    },

    getSubscription(tmdbId) {
      const row = get("SELECT * FROM subscriptions WHERE tmdb_id = :tmdbId", { tmdbId });
      return row ? toSubscription(row) : null;
    },
    saveSubscription(subscription) {
      run(
        `INSERT INTO subscriptions (tmdb_id, name, year, active, updated_at)
         VALUES (:tmdbId, :name, :year, :active, :now)
         ON CONFLICT (tmdb_id) DO UPDATE SET
           name = excluded.name, year = excluded.year, active = excluded.active, updated_at = excluded.updated_at`,
        {
          tmdbId: subscription.tmdbId,
          name: subscription.name,
          year: subscription.year,
          active: flag(subscription.active),
          now: clock(),
        },
      );
    },
    listSubscriptions() {
      return all("SELECT * FROM subscriptions ORDER BY name, tmdb_id").map(toSubscription);
    },
    getPremieres(tmdbId): KnownPremiere[] {
      return all("SELECT * FROM premieres WHERE tmdb_id = :tmdbId ORDER BY season_number", { tmdbId }).map((row) => ({
        seasonNumber: int(row, "season_number"),
        airDate: textOrNull(row, "air_date"),
        todayNotifiedOn: textOrNull(row, "today_notified_on"),
      }));
    },
    savePremieres(tmdbId, premieres) {
      transaction(() => {
        for (const premiere of premieres) {
          run(
            `INSERT INTO premieres (tmdb_id, season_number, air_date, today_notified_on)
             VALUES (:tmdbId, :seasonNumber, :airDate, :todayNotifiedOn)
             ON CONFLICT (tmdb_id, season_number) DO UPDATE SET
               air_date = excluded.air_date, today_notified_on = excluded.today_notified_on`,
            { tmdbId, ...premiere },
          );
        }
      });
    },

    getCalendarEvent(tmdbId, seasonNumber) {
      const row = get("SELECT * FROM calendar_events WHERE tmdb_id = :tmdbId AND season_number = :seasonNumber", {
        tmdbId,
        seasonNumber,
      });
      return row ? toCalendarEvent(row) : null;
    },
    saveCalendarEvent(record) {
      run(
        `INSERT INTO calendar_events (tmdb_id, season_number, generation, event_id, status, event_date)
         VALUES (:tmdbId, :seasonNumber, :generation, :eventId, :status, :date)
         ON CONFLICT (tmdb_id, season_number) DO UPDATE SET
           generation = excluded.generation, event_id = excluded.event_id,
           status = excluded.status, event_date = excluded.event_date`,
        { ...record },
      );
    },
    listCalendarEvents() {
      return all("SELECT * FROM calendar_events ORDER BY event_date, tmdb_id, season_number").map(toCalendarEvent);
    },

    findBatch(triggerKey): RecommendationBatch | null {
      const batch = get("SELECT * FROM recommendation_batches WHERE trigger_key = :triggerKey", { triggerKey });
      if (!batch) return null;
      const items = all("SELECT * FROM recommendation_items WHERE batch_id = :id ORDER BY position", {
        id: text(batch, "id"),
      });
      return {
        id: text(batch, "id"),
        triggerKey,
        createdAt: int(batch, "created_at"),
        items: items.map((row) => ({
          tmdbId: int(row, "tmdb_id"),
          explanation: text(row, "explanation"),
          card: parseStored(seriesCardSchema, row.card, "recommendation_items.card"),
        })),
      };
    },
    saveBatch(batch) {
      transaction(() => {
        run("INSERT INTO recommendation_batches (id, trigger_key, created_at) VALUES (:id, :triggerKey, :createdAt)", {
          id: batch.id,
          triggerKey: batch.triggerKey,
          createdAt: batch.createdAt,
        });
        batch.items.forEach((item, position) => {
          run(
            `INSERT INTO recommendation_items (batch_id, position, tmdb_id, explanation, card)
             VALUES (:batchId, :position, :tmdbId, :explanation, :card)`,
            {
              batchId: batch.id,
              position,
              tmdbId: item.tmdbId,
              explanation: item.explanation,
              card: JSON.stringify(item.card),
            },
          );
        });
      });
    },
    recommendedIds() {
      return new Set(all("SELECT DISTINCT tmdb_id FROM recommendation_items").map((row) => int(row, "tmdb_id")));
    },

    enqueue(dedupeKey, messages: readonly OutgoingMessage[], now) {
      transaction(() => {
        messages.forEach((message, position) => {
          run(
            `INSERT INTO outbox (id, dedupe_key, position, message, created_at, next_attempt_at)
             VALUES (:id, :dedupeKey, :position, :message, :now, :now)
             ON CONFLICT (dedupe_key, position) DO NOTHING`,
            { id: newId(), dedupeKey, position, message: JSON.stringify(message), now },
          );
        });
      });
    },
    dueMessages(now): OutboxItem[] {
      const pending = all(
        `SELECT id, message, attempts, next_attempt_at FROM outbox
         WHERE sent_at IS NULL ORDER BY rowid`,
      );
      const blocked = pending.findIndex((row) => int(row, "next_attempt_at") > now);
      return (blocked === -1 ? pending : pending.slice(0, blocked)).map((row) => ({
        id: text(row, "id"),
        message: parseStored(outgoingMessageSchema, row.message, "outbox.message"),
        attempts: int(row, "attempts"),
      }));
    },
    markSent(id, now) {
      run("UPDATE outbox SET sent_at = :now, last_error = NULL WHERE id = :id", { id, now });
    },
    markFailed(id, error, nextAttemptAt) {
      run(
        `UPDATE outbox SET attempts = attempts + 1, last_error = :error, next_attempt_at = :nextAttemptAt
         WHERE id = :id`,
        { id, error, nextAttemptAt },
      );
    },
    countPending() {
      return int(get("SELECT COUNT(*) AS count FROM outbox WHERE sent_at IS NULL") ?? { count: 0 }, "count");
    },

    getJob(name) {
      const row = get("SELECT * FROM jobs WHERE name = :name", { name });
      return row ? toJob(row) : null;
    },
    saveJob(job) {
      run(
        `INSERT INTO jobs (name, schedule, next_run_at, last_started_at, last_success_at, last_error, last_error_at)
         VALUES (:name, :schedule, :nextRunAt, :lastStartedAt, :lastSuccessAt, :lastError, :lastErrorAt)
         ON CONFLICT (name) DO UPDATE SET
           schedule = excluded.schedule, next_run_at = excluded.next_run_at,
           last_started_at = excluded.last_started_at, last_success_at = excluded.last_success_at,
           last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
        { ...job },
      );
    },

    recordHealth(service, at, error) {
      if (error === null) {
        run(
          `INSERT INTO service_health (service, last_success_at) VALUES (:service, :at)
           ON CONFLICT (service) DO UPDATE SET last_success_at = excluded.last_success_at`,
          { service, at },
        );
        return;
      }
      run(
        `INSERT INTO service_health (service, last_error, last_error_at) VALUES (:service, :error, :at)
         ON CONFLICT (service) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
        { service, at, error },
      );
    },
    listHealth(): ServiceHealth[] {
      return all("SELECT * FROM service_health ORDER BY service").map((row) => ({
        service: oneOf(SERVICES, textOrNull(row, "service"), "service_health.service"),
        lastSuccessAt: intOrNull(row, "last_success_at"),
        lastError: textOrNull(row, "last_error"),
        lastErrorAt: intOrNull(row, "last_error_at"),
      }));
    },

    getCachedResponse(key, notOlderThan) {
      const row = get("SELECT body FROM catalog_cache WHERE key = :key AND fetched_at >= :notOlderThan", {
        key,
        notOlderThan,
      });
      return row ? text(row, "body") : null;
    },
    saveCachedResponse(key, body, at) {
      run(
        `INSERT INTO catalog_cache (key, body, fetched_at) VALUES (:key, :body, :at)
         ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
        { key, body, at },
      );
    },
  };
}
