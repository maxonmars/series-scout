import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalendarSync } from "../src/application/calendar-sync.ts";
import { ExternalServiceError } from "../src/application/errors.ts";
import { createSerial } from "../src/application/serial.ts";
import { createTracking } from "../src/application/tracking.ts";
import { applyFeedback } from "../src/domain/library.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";
import {
  activeEvents,
  type FakeCalendar,
  type FakeCatalog,
  fakeCalendar,
  fakeCatalog,
  series,
  setSeasons,
  textOf,
} from "./support/fakes.ts";

const DAY_MS = 86_400_000;
// 2026-10-17 10:00 в Новосибирске (03:00 UTC).
const START = Date.UTC(2026, 9, 17, 3, 0);

let now = START;
let test: TestDatabase;
let catalog: FakeCatalog;
let calendar: FakeCalendar;

function services() {
  const serial = createSerial();
  const clock = { now: () => now };
  const calendarSync = createCalendarSync({
    store: test.store,
    subscriptions: test.store,
    events: test.store,
    calendar,
    clock,
    timeZone: "Asia/Novosibirsk",
    serial,
  });
  const tracking = createTracking({
    store: test.store,
    subscriptions: test.store,
    outbox: test.store,
    catalog,
    calendarSync,
    clock,
    timeZone: "Asia/Novosibirsk",
    serial,
  });
  return { tracking, calendarSync };
}

const messages = () => textOf(test.store.dueMessages(now).map((item) => item.message));

beforeEach(() => {
  now = START;
  test = createTestDatabase(() => now);
  catalog = fakeCatalog([
    series(1, "Разделение", {
      firstAirDate: "2022-02-17",
      seasons: [
        { number: 1, airDate: "2022-02-17" },
        { number: 2, airDate: "2026-12-05" },
      ],
    }),
    series(2, "Тьма", { firstAirDate: "2017-12-01", seasons: [{ number: 1, airDate: "2017-12-01" }] }),
  ]);
  calendar = fakeCalendar();
});

afterEach(() => {
  test.cleanup();
});

describe("подписка и календарь", () => {
  it("подписка сообщает о календаре и создаёт событие на весь день с исходной датой", async () => {
    const reply = await services().tracking.follow(1);
    expect(textOf(reply)).toContain("2-й сезон — 5 декабря 2026");
    expect(textOf(reply)).toContain("автоматически попадут в календарь");
    expect(activeEvents(calendar)).toEqual([
      expect.objectContaining({ eventId: "ss1s2g1", date: "2026-12-05", premiereKey: "1:2" }),
    ]);
  });

  it("прошедшие сезоны в календарь не попадают, неизвестная дата не создаёт событие", async () => {
    setSeasons(catalog, 2, [
      { number: 1, airDate: "2017-12-01" },
      { number: 2, airDate: null },
    ]);
    const reply = await services().tracking.follow(2);
    expect(textOf(reply)).toContain("2-й сезон — дата пока неизвестна");
    expect(calendar.events.size).toBe(0);
  });

  it("повторная подписка и повторная проверка не создают дубль", async () => {
    const { tracking } = services();
    await tracking.follow(1);
    expect(textOf(await tracking.follow(1))).toContain("уже следите");
    await tracking.checkAll("run-1");
    await tracking.checkAll("run-2");
    expect(calendar.calls).toEqual(["create ss1s2g1"]);
    expect(test.store.dueMessages(now)).toEqual([]);
  });

  it("новая дата сезона существующего сериала: уведомление и событие", async () => {
    setSeasons(catalog, 2, [
      { number: 1, airDate: "2017-12-01" },
      { number: 2, airDate: null },
    ]);
    const { tracking } = services();
    await tracking.follow(2);
    catalog.seasonDates.set("2:2", "2027-03-01");

    const result = await tracking.checkAll("run-1");
    expect(result.changes).toBe(1);
    expect(messages()).toContain("2-й сезон: объявлена дата — 1 марта 2027");
    expect(activeEvents(calendar).map((event) => event.date)).toEqual(["2027-03-01"]);
  });

  it("перенос через границу года обновляет то же событие", async () => {
    setSeasons(catalog, 1, [{ number: 2, airDate: "2026-12-31" }]);
    const { tracking } = services();
    await tracking.follow(1);
    catalog.seasonDates.set("1:2", "2027-01-02");

    await tracking.checkAll("run-1");
    expect(messages()).toContain("перенос с 31 декабря 2026 на 2 января 2027");
    expect(calendar.calls).toEqual(["create ss1s2g1", "update ss1s2g1"]);
    expect(activeEvents(calendar)).toEqual([expect.objectContaining({ eventId: "ss1s2g1", date: "2027-01-02" })]);
  });

  it("исчезнувшая будущая дата убирает событие и сообщает об этом", async () => {
    const { tracking } = services();
    await tracking.follow(1);
    catalog.seasonDates.set("1:2", null);

    await tracking.checkAll("run-1");
    expect(messages()).toContain("дата 5 декабря 2026 больше не подтверждена");
    expect(activeEvents(calendar)).toEqual([]);
  });

  it("ошибка источника не считается исчезновением даты, остальные сериалы обрабатываются", async () => {
    const { tracking } = services();
    await tracking.follow(1);
    setSeasons(catalog, 2, [{ number: 2, airDate: null }]);
    await tracking.follow(2);
    catalog.failFor.add(1);
    catalog.seasonDates.set("2:2", "2027-02-01");

    const result = await tracking.checkAll("run-1");
    expect(result.failures).toEqual([{ name: "«Разделение» (2022)", reason: "внутренняя ошибка приложения" }]);
    expect(
      activeEvents(calendar)
        .map((event) => event.eventId)
        .sort(),
    ).toEqual(["ss1s2g1", "ss2s2g1"]);
    expect(test.store.getPremieres(1)).toContainEqual(
      expect.objectContaining({ seasonNumber: 2, airDate: "2026-12-05" }),
    );
  });

  it("отписка удаляет будущие события и сохраняет прошедшие, повторная подписка — новое поколение ID", async () => {
    setSeasons(catalog, 1, [
      { number: 2, airDate: "2026-10-20" },
      { number: 3, airDate: "2027-05-01" },
    ]);
    const { tracking } = services();
    await tracking.follow(1);
    now += 5 * DAY_MS;

    expect(textOf(await tracking.unfollow(1))).toContain("прошедшие остаются");
    expect(activeEvents(calendar).map((event) => event.eventId)).toEqual(["ss1s2g1"]);

    await tracking.follow(1);
    expect(
      activeEvents(calendar)
        .map((event) => event.eventId)
        .sort(),
    ).toEqual(["ss1s2g1", "ss1s3g2"]);
  });

  it("подписка не зависит от отметки о просмотре", async () => {
    test.store.saveEntry(applyFeedback(null, { tmdbId: 1, name: "Разделение", year: 2022 }, { kind: "watched" }));
    await services().tracking.follow(1);
    expect(test.store.getEntry(1)?.watched).toBe(true);
    expect(test.store.getSubscription(1)?.active).toBe(true);
  });
});

describe("сбои Google Calendar", () => {
  it("недоступность Google оставляет операцию в очереди, следующая синхронизация её выполняет", async () => {
    calendar.fail = new ExternalServiceError("google", "unavailable", 503);
    const { tracking, calendarSync } = services();
    expect(textOf(await tracking.follow(1))).toContain("Календарь обновится при следующей синхронизации");
    expect(calendarSync.pendingCount()).toBe(1);

    calendar.fail = null;
    expect(await calendarSync.reconcile()).toEqual({ applied: 1, pending: 0, error: null });
    expect(activeEvents(calendar)).toHaveLength(1);
  });

  it("сбой после успешного запроса до локального подтверждения не создаёт дубль", async () => {
    calendar.failAfterApply = new ExternalServiceError("google", "timeout");
    await services().tracking.follow(1);
    expect(test.store.getCalendarEvent(1, 2)?.status).toBe("create");

    calendar.failAfterApply = null;
    test.reopen();
    const { calendarSync } = services();
    await calendarSync.reconcile();
    expect(calendar.calls).toEqual(["create ss1s2g1", "create ss1s2g1"]);
    expect(calendar.events.size).toBe(1);
    expect(test.store.getCalendarEvent(1, 2)?.status).toBe("synced");
    expect(calendarSync.pendingCount()).toBe(0);
  });

  it("событие, удалённое вручную, восстанавливается с новым поколением ID", async () => {
    const { tracking, calendarSync } = services();
    await tracking.follow(1);
    calendar.events.clear();
    catalog.seasonDates.set("1:2", "2026-12-06");

    await tracking.checkAll("run-1");
    expect(calendar.calls).toEqual(["create ss1s2g1", "update ss1s2g1", "create ss1s2g2"]);
    expect(activeEvents(calendar)).toEqual([expect.objectContaining({ eventId: "ss1s2g2", date: "2026-12-06" })]);
    expect(calendarSync.pendingCount()).toBe(0);
  });
});

describe("уведомления о премьерах", () => {
  it("«премьера сегодня» отправляется один раз за день", async () => {
    setSeasons(catalog, 1, [{ number: 2, airDate: "2026-10-18" }]);
    const { tracking } = services();
    await tracking.follow(1);
    now += DAY_MS;

    await tracking.checkAll("run-1");
    await tracking.checkAll("run-2");
    const sent = test.store.dueMessages(now).map((item) => item.message);
    expect(sent).toHaveLength(1);
    expect(textOf(sent)).toContain("2-й сезон: премьера сегодня!");
  });

  it("после простоя пропущенная премьера не объявляется задним числом", async () => {
    setSeasons(catalog, 1, [{ number: 2, airDate: "2026-10-18" }]);
    const { tracking } = services();
    await tracking.follow(1);
    now += 3 * DAY_MS;

    const result = await tracking.checkAll("run-1");
    expect(result.changes).toBe(0);
    expect(test.store.dueMessages(now)).toEqual([]);
  });

  it("изменения нескольких сериалов собираются в одно сообщение", async () => {
    setSeasons(catalog, 2, [{ number: 2, airDate: null }]);
    const { tracking } = services();
    await tracking.follow(1);
    await tracking.follow(2);
    catalog.seasonDates.set("1:2", "2026-12-12");
    catalog.seasonDates.set("2:2", "2027-01-15");

    await tracking.checkAll("run-1");
    const sent = test.store.dueMessages(now);
    expect(sent).toHaveLength(1);
    expect(textOf(sent.map((item) => item.message))).toMatch(/Разделение[\s\S]*перенос[\s\S]*Тьма[\s\S]*объявлена/);
  });

  it("дата не зависит от часового пояса сервера: «сегодня» считается в зоне пользователя", async () => {
    setSeasons(catalog, 1, [{ number: 2, airDate: "2026-10-18" }]);
    const { tracking } = services();
    await tracking.follow(1);
    // 2026-10-17 19:00 UTC — в Новосибирске уже 18 октября.
    now = Date.UTC(2026, 9, 17, 19, 0);

    await tracking.checkAll("run-1");
    expect(messages()).toContain("премьера сегодня");
  });
});

describe("последовательность операций", () => {
  it("ручная и фоновая проверка не выполняются одновременно", async () => {
    const { tracking } = services();
    await tracking.follow(1);
    const order: string[] = [];
    catalog.onGetSeries = async () => {
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("end");
    };

    await Promise.all([tracking.checkAll("daily"), tracking.checkAll("manual")]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });
});
