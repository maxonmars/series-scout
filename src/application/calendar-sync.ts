import { afterDeletion, type CalendarEventRecord, calendarEventId, planCalendarEvent } from "../domain/calendar.ts";
import { localDate } from "../domain/dates.ts";
import { premiereKey } from "../domain/premieres.ts";
import { seriesUrl } from "../domain/series.ts";
import { describeError } from "./errors.ts";
import type { CalendarEvent, CalendarPort, CalendarStore, Clock, SubscriptionStore, Transactional } from "./ports.ts";
import type { Serial } from "./serial.ts";

export type CalendarSyncDeps = {
  readonly store: Transactional;
  readonly subscriptions: SubscriptionStore;
  readonly events: CalendarStore;
  readonly calendar: CalendarPort;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly serial: Serial;
};

/** `error` — причина, по которой часть операций осталась в очереди до следующей синхронизации. */
export type CalendarSyncResult = { readonly applied: number; readonly pending: number; readonly error: string | null };

const isPending = (record: CalendarEventRecord) =>
  record.status === "create" || record.status === "update" || record.status === "delete";

/** Календарь — представление состояния бота: желаемое состояние сохраняется до сетевых вызовов. */
export function createCalendarSync(deps: CalendarSyncDeps) {
  function plan(today: string): void {
    deps.store.transaction(() => {
      for (const subscription of deps.subscriptions.listSubscriptions()) {
        for (const premiere of deps.subscriptions.getPremieres(subscription.tmdbId)) {
          const target = { tmdbId: subscription.tmdbId, seasonNumber: premiere.seasonNumber };
          const record = deps.events.getCalendarEvent(target.tmdbId, target.seasonNumber);
          const desired = subscription.active ? premiere.airDate : null;
          const next = planCalendarEvent(target, record, desired, today);
          if (next !== null && next !== record) deps.events.saveCalendarEvent(next);
        }
      }
    });
  }

  function toEvent(record: CalendarEventRecord): CalendarEvent {
    const name = deps.subscriptions.getSubscription(record.tmdbId)?.name ?? `TMDB ${record.tmdbId}`;
    return {
      eventId: record.eventId,
      premiereKey: premiereKey(record.tmdbId, record.seasonNumber),
      date: record.date,
      summary: `«${name}»: ${record.seasonNumber}-й сезон`,
      description: [
        `Премьера ${record.seasonNumber}-го сезона сериала «${name}».`,
        `Источник: TMDB — ${seriesUrl(record.tmdbId)}`,
        "Событие ведёт Series Scout: изменения дат и отписка — в боте.",
      ].join("\n"),
    };
  }

  async function apply(record: CalendarEventRecord): Promise<void> {
    if (record.status === "delete") {
      await deps.calendar.deleteEvent(record.eventId);
      deps.events.saveCalendarEvent(afterDeletion(record));
      return;
    }
    if (record.status === "update" && (await deps.calendar.updateEvent(toEvent(record))) === "updated") {
      deps.events.saveCalendarEvent({ ...record, status: "synced" });
      return;
    }
    let creating = record;
    if (record.status === "update") {
      // Событие удалили вручную: прежний ID занят удалённой записью, создаём новое поколение.
      const generation = record.generation + 1;
      creating = {
        ...record,
        generation,
        eventId: calendarEventId(record.tmdbId, record.seasonNumber, generation),
        status: "create",
      };
      deps.events.saveCalendarEvent(creating);
    }
    await deps.calendar.createEvent(toEvent(creating));
    deps.events.saveCalendarEvent({ ...creating, status: "synced" });
  }

  return {
    reconcile(): Promise<CalendarSyncResult> {
      return deps.serial("calendar", async () => {
        plan(localDate(deps.clock.now(), deps.timeZone));
        let applied = 0;
        const queue = deps.events.listCalendarEvents().filter(isPending);
        for (const [index, record] of queue.entries()) {
          try {
            await apply(record);
            applied += 1;
          } catch (error) {
            return { applied, pending: queue.length - index, error: describeError(error) };
          }
        }
        return { applied, pending: 0, error: null };
      });
    },

    pendingCount: () => deps.events.listCalendarEvents().filter(isPending).length,
  };
}

export type CalendarSync = ReturnType<typeof createCalendarSync>;
