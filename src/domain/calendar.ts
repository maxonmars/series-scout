import type { IsoDate } from "./dates.ts";

export const PRODUCT_ID = "series-scout";

/** `create`/`update`/`delete` — операция сохранена, но ещё не подтверждена ответом Google. */
export type CalendarEventStatus = "create" | "update" | "delete" | "synced" | "deleted";

/** Привязка премьеры к событию Google. Поколение растёт после удаления, чтобы новое событие получило новый ID. */
export type CalendarEventRecord = {
  readonly tmdbId: number;
  readonly seasonNumber: number;
  readonly generation: number;
  readonly eventId: string;
  readonly status: CalendarEventStatus;
  readonly date: IsoDate;
};

/** Google принимает ID из символов base32hex (`a-v`, `0-9`) длиной от 5 символов. */
export function calendarEventId(tmdbId: number, seasonNumber: number, generation: number): string {
  return `ss${tmdbId}s${seasonNumber}g${generation}`;
}

type Target = { readonly tmdbId: number; readonly seasonNumber: number };

/**
 * Следующее состояние привязки. `desiredDate` — известная дата при активной подписке, иначе `null`.
 * Прошедшие события не удаляются; события на прошедшие даты не создаются.
 */
export function planCalendarEvent(
  target: Target,
  record: CalendarEventRecord | null,
  desiredDate: IsoDate | null,
  today: IsoDate,
): CalendarEventRecord | null {
  if (desiredDate !== null) {
    if (record === null || record.status === "deleted") {
      if (desiredDate < today) return record;
      const generation = record === null ? 1 : record.generation;
      return {
        ...target,
        generation,
        eventId: calendarEventId(target.tmdbId, target.seasonNumber, generation),
        status: "create",
        date: desiredDate,
      };
    }
    if (record.status === "create") return record.date === desiredDate ? record : { ...record, date: desiredDate };
    if (record.status === "delete") return { ...record, status: "update", date: desiredDate };
    if (record.date === desiredDate) return record;
    return { ...record, status: "update", date: desiredDate };
  }

  if (record === null || record.status === "deleted" || record.status === "delete") return record;
  if (record.date < today) return record;
  return { ...record, status: "delete" };
}

/** Состояние после подтверждённого удаления: следующее создание использует новое поколение. */
export function afterDeletion(record: CalendarEventRecord): CalendarEventRecord {
  return { ...record, status: "deleted", generation: record.generation + 1 };
}
