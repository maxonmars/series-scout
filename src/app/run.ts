import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDeepSeekTasteModel } from "../adapters/deepseek/taste-model.ts";
import { createGoogleCalendar } from "../adapters/google/calendar.ts";
import type { ReportHealth } from "../adapters/http.ts";
import { DatabaseLockedError, openDatabase } from "../adapters/sqlite/database.ts";
import { createSqliteStore } from "../adapters/sqlite/store.ts";
import { createTelegramBot, type TelegramBot } from "../adapters/telegram/bot.ts";
import { createTmdbCatalog } from "../adapters/tmdb/catalog.ts";
import { describeError, describeForLog } from "../application/errors.ts";
import type { Logger, NotificationPort } from "../application/ports.ts";
import { composeApplication } from "./compose.ts";
import type { AppConfig } from "./settings.ts";

const TICK_INTERVAL_MS = 60_000;
export const DATABASE_FILE = "series-scout.db";

export type ServiceContext = {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Регистрирует обработчик сигнала остановки процесса. */
  readonly onShutdown: (handler: () => void) => void;
};

function loadPrompts() {
  const read = (name: string) => readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
  return { interview: read("interview.md"), ranking: read("ranking.md") };
}

/** Долгоживущий процесс: Telegram long polling и планировщик до сигнала остановки. Возвращает код завершения. */
export async function runService({ config, logger, onShutdown }: ServiceContext): Promise<number> {
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(join(config.dataDir, DATABASE_FILE), { exclusive: true });
  } catch (error) {
    logger.error(
      error instanceof DatabaseLockedError ? error.message : `Не удалось открыть базу: ${describeForLog(error)}`,
    );
    return 1;
  }

  const clock = { now: () => Date.now() };
  const store = createSqliteStore(db, clock.now, randomUUID);
  const reportHealth: ReportHealth = (service, error) =>
    store.recordHealth(service, clock.now(), error === null ? null : describeError(error));

  let telegram: TelegramBot | undefined;
  const notifications: NotificationPort = {
    send: (message) => {
      if (!telegram) throw new Error("Telegram-бот ещё не создан");
      return telegram.notifications.send(message);
    },
  };

  const app = composeApplication({
    store,
    catalog: createTmdbCatalog({
      readAccessToken: config.tmdb.readAccessToken,
      cache: store,
      now: clock.now,
      reportHealth,
    }),
    model: createDeepSeekTasteModel({
      apiKey: config.deepseek.apiKey,
      model: config.deepseek.model,
      prompts: loadPrompts(),
      reportHealth,
    }),
    calendar: createGoogleCalendar({ ...config.google, reportHealth }),
    notifications,
    clock,
    newId: randomUUID,
    logger,
    timeZone: config.timeZone,
    schedules: config.schedules,
  });
  const bot = createTelegramBot({
    token: config.telegram.token,
    ownerId: config.telegram.ownerId,
    scenarios: app.scenarios,
    logger,
    reportHealth,
  });
  telegram = bot;

  let stopping = false;
  onShutdown(() => {
    if (stopping) return;
    stopping = true;
    logger.info("Получен сигнал остановки: завершаю текущие операции");
    void bot.stop();
  });

  app.scheduler.start(TICK_INTERVAL_MS);
  logger.info(`Series Scout запущен: часовой пояс ${config.timeZone}`);
  let code = 0;
  try {
    await bot.start();
  } catch (error) {
    logger.error(`Telegram: получение обновлений остановлено — ${describeForLog(error)}`);
    code = 1;
  } finally {
    await app.scheduler.stop();
    db.close();
    logger.info("Series Scout остановлен");
  }
  return code;
}
