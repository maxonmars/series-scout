import type { IsoDate } from "./dates.ts";
import type { Season } from "./series.ts";

/** Подписка на новые сезоны; после отписки запись остаётся с `active: false`. */
export type Subscription = {
  readonly tmdbId: number;
  readonly name: string;
  readonly year: number | null;
  readonly active: boolean;
};

/** Последнее подтверждённое источником состояние сезона. */
export type KnownPremiere = {
  readonly seasonNumber: number;
  readonly airDate: IsoDate | null;
  /** Дата, за которую уже отправлено «премьера сегодня». */
  readonly todayNotifiedOn: IsoDate | null;
};

export type PremiereChange =
  | { readonly kind: "announced"; readonly seasonNumber: number; readonly date: IsoDate }
  | { readonly kind: "rescheduled"; readonly seasonNumber: number; readonly from: IsoDate; readonly to: IsoDate }
  | { readonly kind: "unconfirmed"; readonly seasonNumber: number; readonly previous: IsoDate }
  | { readonly kind: "today"; readonly seasonNumber: number; readonly date: IsoDate };

export const premiereKey = (tmdbId: number, seasonNumber: number): string => `${tmdbId}:${seasonNumber}`;

/**
 * Изменения дат относительно прошлой проверки. Прошедшие даты не порождают уведомлений:
 * после простоя пропущенные премьеры не объявляются задним числом.
 */
export function diffPremieres(previous: readonly KnownPremiere[], current: readonly Season[], today: IsoDate) {
  const changes: PremiereChange[] = [];
  const before = new Map(previous.map((premiere) => [premiere.seasonNumber, premiere]));

  for (const season of current) {
    const prev = before.get(season.number);
    before.delete(season.number);
    const prevDate = prev?.airDate ?? null;
    const date = season.airDate;

    if (date === today) {
      if (prev?.todayNotifiedOn !== today) changes.push({ kind: "today", seasonNumber: season.number, date });
    } else if (date !== null && prevDate === null) {
      if (date > today) changes.push({ kind: "announced", seasonNumber: season.number, date });
    } else if (date !== null && prevDate !== null && date !== prevDate) {
      if (date > today || prevDate >= today) {
        changes.push({ kind: "rescheduled", seasonNumber: season.number, from: prevDate, to: date });
      }
    } else if (date === null && prevDate !== null && prevDate >= today) {
      changes.push({ kind: "unconfirmed", seasonNumber: season.number, previous: prevDate });
    }
  }

  for (const removed of before.values()) {
    if (removed.airDate !== null && removed.airDate >= today) {
      changes.push({ kind: "unconfirmed", seasonNumber: removed.seasonNumber, previous: removed.airDate });
    }
  }
  return changes.sort((a, b) => a.seasonNumber - b.seasonNumber);
}

/** Новое сохраняемое состояние: сезоны, исчезнувшие из источника, остаются с неизвестной датой. */
export function nextKnownPremieres(
  previous: readonly KnownPremiere[],
  current: readonly Season[],
  today: IsoDate,
): KnownPremiere[] {
  const byNumber = new Map(previous.map((premiere) => [premiere.seasonNumber, premiere]));
  const result = new Map<number, KnownPremiere>();
  for (const prev of previous) result.set(prev.seasonNumber, { ...prev, airDate: null });
  for (const season of current) {
    const prev = byNumber.get(season.number);
    const notifiedToday = season.airDate === today ? today : (prev?.todayNotifiedOn ?? null);
    result.set(season.number, { seasonNumber: season.number, airDate: season.airDate, todayNotifiedOn: notifiedToday });
  }
  return [...result.values()].sort((a, b) => a.seasonNumber - b.seasonNumber);
}
