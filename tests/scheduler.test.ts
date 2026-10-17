import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelivery } from "../src/application/delivery.ts";
import { ExternalServiceError } from "../src/application/errors.ts";
import type { OutgoingMessage } from "../src/application/ports.ts";
import { createScheduler, type JobDefinition } from "../src/application/scheduler.ts";
import { createSerial } from "../src/application/serial.ts";
import { nextOccurrence } from "../src/domain/schedule.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";

const ZONE = "Asia/Novosibirsk";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();

describe("расчёт расписания", () => {
  it("воскресенье 18:00 считается в зоне пользователя", () => {
    // Среда 2026-10-14 12:00 UTC.
    const next = nextOccurrence(Date.UTC(2026, 9, 14, 12), { time: "18:00", weekday: "sunday" }, ZONE);
    expect(iso(next)).toBe("2026-10-18T11:00:00.000Z");
  });

  it("в воскресенье после 18:00 следующий запуск — через неделю", () => {
    const next = nextOccurrence(Date.UTC(2026, 9, 18, 11, 0), { time: "18:00", weekday: "sunday" }, ZONE);
    expect(iso(next)).toBe("2026-10-25T11:00:00.000Z");
  });

  it("ежедневно в 09:00: сегодня, если время ещё не наступило, иначе завтра", () => {
    expect(iso(nextOccurrence(Date.UTC(2026, 9, 17, 1, 0), { time: "09:00" }, ZONE))).toBe("2026-10-17T02:00:00.000Z");
    expect(iso(nextOccurrence(Date.UTC(2026, 9, 17, 2, 0), { time: "09:00" }, ZONE))).toBe("2026-10-18T02:00:00.000Z");
  });

  it("пропускает несуществующее время перехода на летнее время", () => {
    // 2027-03-28 в Берлине часы переводятся с 02:00 на 03:00.
    const next = nextOccurrence(Date.UTC(2027, 2, 27, 12), { time: "02:30" }, "Europe/Berlin");
    expect(iso(next)).toBe("2027-03-29T00:30:00.000Z");
  });
});

describe("планировщик", () => {
  let test: TestDatabase;
  let now: number;
  const logs: string[] = [];

  beforeEach(() => {
    now = Date.UTC(2026, 9, 17, 1, 0);
    test = createTestDatabase(() => now);
    logs.length = 0;
  });

  afterEach(() => {
    test.cleanup();
  });

  function scheduler(job: JobDefinition) {
    return createScheduler({
      jobs: [job],
      store: test.store,
      clock: { now: () => now },
      timeZone: ZONE,
      logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
      maintenance: async () => {},
    });
  }

  function recordingJob(runs: number[], time = "09:00"): JobDefinition {
    return {
      name: "premiere-check",
      schedule: { time },
      run: async (scheduledAt) => {
        runs.push(scheduledAt);
      },
    };
  }

  it("при первом запуске назначает срок, а не выполняет задание сразу", async () => {
    const runs: number[] = [];
    await scheduler(recordingJob(runs)).tick();
    expect(runs).toEqual([]);
    expect(iso(test.store.getJob("premiere-check")?.nextRunAt ?? 0)).toBe("2026-10-17T02:00:00.000Z");
  });

  it("ежедневный запуск выполняется в срок и переносится на следующий день", async () => {
    const runs: number[] = [];
    const instance = scheduler(recordingJob(runs));
    await instance.tick();
    now = Date.UTC(2026, 9, 17, 2, 0);
    await instance.tick();
    await instance.tick();
    expect(runs.map(iso)).toEqual(["2026-10-17T02:00:00.000Z"]);
    expect(iso(test.store.getJob("premiere-check")?.nextRunAt ?? 0)).toBe("2026-10-18T02:00:00.000Z");
  });

  it("после простоя выполняет один актуальный запуск и считает следующий срок от текущего момента", async () => {
    const runs: number[] = [];
    await scheduler(recordingJob(runs)).tick();
    now += 3 * DAY_MS + 5 * HOUR_MS;

    test.reopen();
    await scheduler(recordingJob(runs)).tick();
    expect(runs).toHaveLength(1);
    expect(iso(test.store.getJob("premiere-check")?.nextRunAt ?? 0)).toBe("2026-10-21T02:00:00.000Z");
  });

  it("перезапуск посреди задания повторяет его с тем же сроком", async () => {
    await scheduler(recordingJob([])).tick();
    now = Date.UTC(2026, 9, 17, 2, 0);
    const interrupted = scheduler({
      name: "premiere-check",
      schedule: { time: "09:00" },
      run: () => new Promise(() => {}),
    });
    void interrupted.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    test.reopen();
    const runs: number[] = [];
    await scheduler(recordingJob(runs)).tick();
    expect(runs.map(iso)).toEqual(["2026-10-17T02:00:00.000Z"]);
  });

  it("смена времени в настройках пересчитывает срок", async () => {
    await scheduler(recordingJob([])).tick();
    await scheduler(recordingJob([], "07:30")).tick();
    expect(iso(test.store.getJob("premiere-check")?.nextRunAt ?? 0)).toBe("2026-10-18T00:30:00.000Z");
  });

  it("ошибка задания сохраняется для /status, следующий срок назначается", async () => {
    await scheduler(recordingJob([])).tick();
    now = Date.UTC(2026, 9, 17, 2, 0);
    await scheduler({
      name: "premiere-check",
      schedule: { time: "09:00" },
      run: async () => {
        throw new ExternalServiceError("tmdb", "auth", 401);
      },
    }).tick();
    const job = test.store.getJob("premiere-check");
    expect(job?.lastError).toBe("TMDB: ключ отклонён — проверьте TMDB_READ_ACCESS_TOKEN");
    expect(iso(job?.nextRunAt ?? 0)).toBe("2026-10-18T02:00:00.000Z");
  });
});

describe("доставка", () => {
  let test: TestDatabase;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    test = createTestDatabase(() => now);
  });

  afterEach(() => {
    test.cleanup();
  });

  const message = (text: string): OutgoingMessage => ({ kind: "text", text });

  it("ошибка доставки сохраняет сообщения и порядок, повтор отправляет их без повторной генерации", async () => {
    const sent: string[] = [];
    let failing = true;
    const delivery = createDelivery({
      outbox: test.store,
      clock: { now: () => now },
      serial: createSerial(),
      notifications: {
        send: async (item) => {
          if (failing) throw new ExternalServiceError("telegram", "unavailable");
          sent.push(item.kind === "text" ? item.text : "");
        },
      },
    });
    test.store.enqueue("batch", [message("первое"), message("второе")], now);

    expect(await delivery.deliver()).toEqual({ sent: 0, error: "Telegram: сервис недоступен" });
    failing = false;
    expect(await delivery.deliver()).toEqual({ sent: 0, error: null });
    expect(test.store.countPending()).toBe(2);

    now += 61_000;
    expect(await delivery.deliver()).toEqual({ sent: 2, error: null });
    expect(sent).toEqual(["первое", "второе"]);
    expect(await delivery.deliver()).toEqual({ sent: 0, error: null });
  });
});
