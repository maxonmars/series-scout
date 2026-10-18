import type { SqliteStore } from "../adapters/sqlite/store.ts";
import { createBotScenarios } from "../application/bot.ts";
import { createCalendarSync } from "../application/calendar-sync.ts";
import { createDelivery } from "../application/delivery.ts";
import { createInterview } from "../application/interview.ts";
import { createJobs } from "../application/jobs.ts";
import { createLibrary } from "../application/library.ts";
import type {
  CalendarPort,
  CatalogPort,
  Clock,
  IdGenerator,
  Logger,
  NotificationPort,
  TasteModelPort,
} from "../application/ports.ts";
import { createRecommendations } from "../application/recommendations.ts";
import { createScheduler } from "../application/scheduler.ts";
import { createSerial } from "../application/serial.ts";
import { renderStatus } from "../application/status.ts";
import { createTracking } from "../application/tracking.ts";
import type { LocalSchedule } from "../domain/schedule.ts";

export type ApplicationDeps = {
  readonly store: SqliteStore;
  readonly catalog: CatalogPort;
  readonly model: TasteModelPort;
  readonly calendar: CalendarPort;
  readonly notifications: NotificationPort;
  readonly clock: Clock;
  readonly newId: IdGenerator;
  readonly logger: Logger;
  readonly timeZone: string;
  readonly schedules: { readonly premiereCheck: LocalSchedule; readonly weeklyRecommendations: LocalSchedule };
};

/** Связывает сценарии с адаптерами; внешние сервисы передаются уже созданными. */
export function composeApplication(deps: ApplicationDeps) {
  const { store, clock, timeZone, newId } = deps;
  const serial = createSerial();

  const calendarSync = createCalendarSync({
    store,
    subscriptions: store,
    events: store,
    calendar: deps.calendar,
    clock,
    timeZone,
    serial,
  });
  const tracking = createTracking({
    store,
    subscriptions: store,
    outbox: store,
    catalog: deps.catalog,
    calendarSync,
    clock,
    timeZone,
    serial,
  });
  const recommendations = createRecommendations({
    store,
    profiles: store,
    library: store,
    subscriptions: store,
    recommendations: store,
    outbox: store,
    catalog: deps.catalog,
    model: deps.model,
    clock,
    newId,
    timeZone,
  });
  const delivery = createDelivery({ outbox: store, notifications: deps.notifications, clock, serial });
  const interview = createInterview({ profiles: store, catalog: deps.catalog, model: deps.model });
  const library = createLibrary({ library: store, subscriptions: store, dialog: store, catalog: deps.catalog });

  const scheduler = createScheduler({
    jobs: createJobs({
      tracking,
      recommendations,
      delivery,
      serial,
      premiereCheck: deps.schedules.premiereCheck,
      weeklyRecommendations: deps.schedules.weeklyRecommendations,
    }),
    store,
    clock,
    timeZone,
    logger: deps.logger,
    async maintenance() {
      if (calendarSync.pendingCount() > 0) await calendarSync.reconcile();
      await delivery.deliver();
    },
  });

  const scenarios = createBotScenarios({
    interview,
    library,
    tracking,
    recommendations,
    delivery,
    dialog: store,
    newId,
    serial,
    status: () =>
      renderStatus({
        health: store,
        subscriptions: store,
        outbox: store,
        jobs: scheduler.jobs,
        calendarPending: calendarSync.pendingCount,
        timeZone,
      }),
  });

  return { scenarios, scheduler, tracking, calendarSync, delivery };
}

export type Application = ReturnType<typeof composeApplication>;
