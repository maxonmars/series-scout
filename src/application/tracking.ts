import { type IsoDate, localDate } from "../domain/dates.ts";
import {
  diffPremieres,
  type KnownPremiere,
  nextKnownPremieres,
  type PremiereChange,
  type Subscription,
} from "../domain/premieres.ts";
import { displayName, type Season, type SeriesDetails } from "../domain/series.ts";
import type { CalendarSync, CalendarSyncResult } from "./calendar-sync.ts";
import { describeError } from "./errors.ts";
import { formatDate } from "./format.ts";
import type {
  Button,
  CatalogPort,
  Clock,
  OutboxStore,
  OutgoingMessage,
  SubscriptionStore,
  Transactional,
} from "./ports.ts";
import type { Serial } from "./serial.ts";

export type TrackingDeps = {
  readonly store: Transactional;
  readonly subscriptions: SubscriptionStore;
  readonly outbox: OutboxStore;
  readonly catalog: CatalogPort;
  readonly calendarSync: CalendarSync;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly serial: Serial;
};

export type CheckResult = {
  readonly checked: number;
  readonly changes: number;
  readonly failures: readonly { readonly name: string; readonly reason: string }[];
  readonly calendar: CalendarSyncResult;
};

const text = (value: string, buttons?: readonly (readonly Button[])[]): OutgoingMessage =>
  buttons === undefined ? { kind: "text", text: value } : { kind: "text", text: value, buttons };

function describeChange(change: PremiereChange): string {
  const season = `${change.seasonNumber}-й сезон`;
  switch (change.kind) {
    case "announced":
      return `${season}: объявлена дата — ${formatDate(change.date)}`;
    case "rescheduled":
      return `${season}: перенос с ${formatDate(change.from)} на ${formatDate(change.to)}`;
    case "unconfirmed":
      return `${season}: дата ${formatDate(change.previous)} больше не подтверждена источником, событие будет удалено из календаря`;
    case "today":
      return `${season}: премьера сегодня!`;
  }
}

function describeKnown(premieres: readonly KnownPremiere[], today: IsoDate): string {
  const upcoming = premieres.flatMap(({ seasonNumber, airDate }) =>
    airDate !== null && airDate >= today ? [`${seasonNumber}-й сезон — ${formatDate(airDate)}`] : [],
  );
  if (upcoming.length > 0) return upcoming.join("; ");
  const nextUnknown = premieres.filter((premiere) => premiere.airDate === null).at(-1);
  if (nextUnknown) return `${nextUnknown.seasonNumber}-й сезон — дата пока неизвестна`;
  return "дата следующего сезона пока неизвестна";
}

export function createTracking(deps: TrackingDeps) {
  const today = () => localDate(deps.clock.now(), deps.timeZone);

  /** Для будущих сезонов и сезонов без даты дата берётся из карточки сезона. */
  async function freshSeasons(details: SeriesDetails, day: IsoDate): Promise<Season[]> {
    const seasons: Season[] = [];
    for (const season of details.seasons) {
      if (season.airDate !== null && season.airDate < day) {
        seasons.push(season);
        continue;
      }
      seasons.push({
        number: season.number,
        airDate: await deps.catalog.getSeasonAirDate(details.tmdbId, season.number),
      });
    }
    return seasons;
  }

  async function syncCalendarNote(): Promise<string> {
    const result = await deps.calendarSync.reconcile();
    return result.error === null ? "" : `\n\nКалендарь обновится при следующей синхронизации: ${result.error}.`;
  }

  async function checkAll(runKey: string): Promise<CheckResult> {
    const day = today();
    const active = deps.subscriptions.listSubscriptions().filter((subscription) => subscription.active);
    const updates: { subscription: Subscription; premieres: KnownPremiere[]; changes: PremiereChange[] }[] = [];
    const failures: { name: string; reason: string }[] = [];

    for (const subscription of active) {
      try {
        const details = await deps.catalog.getSeries(subscription.tmdbId, { fresh: true });
        const seasons = await freshSeasons(details, day);
        const previous = deps.subscriptions.getPremieres(subscription.tmdbId);
        updates.push({
          subscription: { ...subscription, name: details.name, year: details.year },
          premieres: nextKnownPremieres(previous, seasons, day),
          changes: diffPremieres(previous, seasons, day),
        });
      } catch (error) {
        failures.push({ name: displayName(subscription), reason: describeError(error) });
      }
    }

    const changed = updates.filter((update) => update.changes.length > 0);
    deps.store.transaction(() => {
      for (const update of updates) {
        // Подписку могли отменить во время проверки: флаг берётся из текущей записи.
        const current = deps.subscriptions.getSubscription(update.subscription.tmdbId);
        if (current) deps.subscriptions.saveSubscription({ ...update.subscription, active: current.active });
        deps.subscriptions.savePremieres(update.subscription.tmdbId, update.premieres);
      }
      if (changed.length > 0) {
        const lines = changed.flatMap((update) => [
          displayName(update.subscription),
          ...update.changes.map((change) => `  • ${describeChange(change)}`),
        ]);
        deps.outbox.enqueue(`premiere-check:${runKey}`, [text(`Премьеры:\n\n${lines.join("\n")}`)], deps.clock.now());
      }
    });

    const calendar = await deps.calendarSync.reconcile();
    const changes = changed.reduce((total, update) => total + update.changes.length, 0);
    return { checked: active.length, changes, failures, calendar };
  }

  return {
    checkAll: (runKey: string) => deps.serial("premiere-check", () => checkAll(runKey)),

    async follow(tmdbId: number): Promise<OutgoingMessage[]> {
      const existing = deps.subscriptions.getSubscription(tmdbId);
      const day = today();
      if (existing?.active) {
        const known = describeKnown(deps.subscriptions.getPremieres(tmdbId), day);
        return [text(`Вы уже следите за ${displayName(existing)}: ${known}.`)];
      }
      const { details, premieres } = await deps.serial("premiere-check", async () => {
        const details = await deps.catalog.getSeries(tmdbId, { fresh: true });
        const seasons = await freshSeasons(details, day);
        const premieres = nextKnownPremieres(deps.subscriptions.getPremieres(tmdbId), seasons, day);
        deps.store.transaction(() => {
          deps.subscriptions.saveSubscription({ tmdbId, name: details.name, year: details.year, active: true });
          deps.subscriptions.savePremieres(tmdbId, premieres);
        });
        return { details, premieres };
      });
      const note = await syncCalendarNote();
      return [
        text(
          `Вы следите за ${displayName(details)}: ${describeKnown(premieres, day)}.\n` +
            `Будущие премьеры автоматически попадут в календарь Series Scout.${note}`,
        ),
      ];
    },

    async unfollow(tmdbId: number): Promise<OutgoingMessage[]> {
      const existing = deps.subscriptions.getSubscription(tmdbId);
      if (!existing?.active) return [text("Подписки на этот сериал нет.")];
      deps.subscriptions.saveSubscription({ ...existing, active: false });
      const note = await syncCalendarNote();
      return [
        text(
          `Отслеживание ${displayName(existing)} остановлено. Будущие события сериала удаляются из календаря, прошедшие остаются.${note}`,
        ),
      ];
    },

    following(): OutgoingMessage[] {
      const day = today();
      const active = deps.subscriptions.listSubscriptions().filter((subscription) => subscription.active);
      if (active.length === 0) {
        return [text("Подписок пока нет. Нажмите «Следить за сезонами» на карточке сериала: /search.")];
      }
      const lines = active.map(
        (subscription) =>
          `• ${displayName(subscription)}: ${describeKnown(deps.subscriptions.getPremieres(subscription.tmdbId), day)}`,
      );
      return [
        text(
          `Подписки на новые сезоны:\n${lines.join("\n")}`,
          active.map((subscription) => [
            {
              text: `Не следить: ${subscription.name}`,
              action: { type: "unfollow", tmdbId: subscription.tmdbId },
            },
          ]),
        ),
      ];
    },
  };
}

export type Tracking = ReturnType<typeof createTracking>;
