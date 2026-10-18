import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramBot, type TelegramBot } from "../src/adapters/telegram/bot.ts";
import { decodeAction, encodeAction } from "../src/adapters/telegram/render.ts";
import { type Application, composeApplication } from "../src/app/compose.ts";
import type { ButtonAction, NotificationPort } from "../src/application/ports.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";
import {
  activeEvents,
  type FakeCalendar,
  type FakeCatalog,
  fakeCalendar,
  fakeCatalog,
  type ScriptedModel,
  scriptedModel,
  series,
} from "./support/fakes.ts";

const OWNER = { id: 4242, is_bot: false, first_name: "Owner" };
const STRANGER = { id: 777, is_bot: false, first_name: "Stranger" };
const PRIVATE = { id: OWNER.id, type: "private" as const, first_name: "Owner" };
const GROUP = { id: -100, type: "group" as const, title: "Группа" };

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "Series Scout",
  username: "series_scout_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

type ApiCall = { method: string; payload: Record<string, unknown> };

const DARK = series(1, "Тьма", { firstAirDate: "2017-12-01" });
const CANDIDATE = series(30, "Разделение", {
  firstAirDate: "2022-02-17",
  seasons: [
    { number: 1, airDate: "2022-02-17" },
    { number: 2, airDate: "2026-12-05" },
  ],
});

let test: TestDatabase;
let catalog: FakeCatalog;
let model: ScriptedModel;
let calendar: FakeCalendar;
let telegram: TelegramBot;
let app: Application;
let calls: ApiCall[];
let failSend: { error_code: number; description: string } | null;
let updateId = 0;

function setup() {
  const notifications: NotificationPort = { send: (message) => telegram.notifications.send(message) };
  let ids = 0;
  app = composeApplication({
    store: test.store,
    catalog,
    model,
    calendar,
    notifications,
    clock: { now: () => Date.UTC(2026, 9, 17, 5, 0) },
    newId: () => `id-${++ids}`,
    logger: { info: () => {}, error: () => {} },
    timeZone: "Asia/Novosibirsk",
    schedules: { premiereCheck: { time: "09:00" }, weeklyRecommendations: { time: "18:00", weekday: "sunday" } },
  });
  telegram = createTelegramBot({
    token: "123456:test-token",
    ownerId: OWNER.id,
    scenarios: app.scenarios,
    logger: { info: () => {}, error: () => {} },
    botInfo: BOT_INFO,
  });
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage" && failSend) {
      return { ok: false, ...failSend } as never;
    }
    const result = method === "sendMessage" ? { message_id: calls.length, date: 0, chat: PRIVATE, text: "" } : true;
    return { ok: true, result } as never;
  });
}

function message(text: string, from = OWNER, chat: typeof PRIVATE | typeof GROUP = PRIVATE): Update {
  const command = text.startsWith("/") ? text.split(" ")[0] : undefined;
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat,
      from,
      text,
      ...(command ? { entities: [{ type: "bot_command" as const, offset: 0, length: command.length }] } : {}),
    },
  } as Update;
}

function callback(action: ButtonAction, from = OWNER): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from,
      chat_instance: "chat",
      data: encodeAction(action),
      message: { message_id: 1, date: 0, chat: PRIVATE, text: "карточка" },
    },
  } as Update;
}

async function send(update: Update): Promise<ApiCall[]> {
  const before = calls.length;
  await telegram.bot.handleUpdate(update);
  return calls.slice(before);
}

const texts = (sent: ApiCall[]) =>
  sent.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));

const callbackData = (sent: ApiCall[]) =>
  sent.flatMap((call) => {
    const markup = call.payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
    return markup?.inline_keyboard?.flat().map((button) => button.callback_data) ?? [];
  });

beforeEach(() => {
  test = createTestDatabase();
  catalog = fakeCatalog([DARK, CANDIDATE]);
  catalog.searchResults = { Тьма: [DARK] };
  catalog.recommendations = { 1: [CANDIDATE] };
  model = scriptedModel();
  calendar = fakeCalendar();
  calls = [];
  failSend = null;
  setup();
});

afterEach(() => {
  test.cleanup();
});

describe("Telegram: пользовательский сценарий", () => {
  it("от /start до сохранённого сериала и подписки с событием в календаре", async () => {
    expect(texts(await send(message("/start")))).toEqual([
      expect.stringContaining("Series Scout"),
      expect.stringContaining("Расскажите"),
    ]);

    model.interview = () => ({ mentionedTitles: [{ query: "Тьма", sentiment: "liked", reason: "атмосфера" }] });
    const resolving = await send(message("Обожаю Тьму за атмосферу"));
    expect(callbackData(resolving)).toEqual(["p:1", "st"]);

    const summary = await send(callback({ type: "pick_title", tmdbId: 1 }));
    expect(summary.map((call) => call.method)).toContain("editMessageReplyMarkup");
    expect(texts(summary)[0]).toContain("Итог профиля");

    expect(texts(await send(callback({ type: "confirm_profile" })))).toEqual([
      expect.stringContaining("Профиль сохранён"),
    ]);

    const recommended = await send(message("/recommend"));
    const card = recommended.find((call) => call.payload.parse_mode === "HTML");
    expect(texts(recommended)[0]).toContain("Подбираю");
    expect(String(card?.payload.text)).toContain("<b>Разделение</b> (2022)");
    expect(String(card?.payload.text)).toContain("Почему:");
    expect(String(card?.payload.text)).toContain("https://www.themoviedb.org/tv/30");
    expect(callbackData([card ?? { method: "", payload: {} }])).toEqual(["w:30", "s:30", "n:30", "f:30"]);

    expect(texts(await send(callback({ type: "want", tmdbId: 30 })))[0]).toContain("«Хочу посмотреть»");
    expect(texts(await send(message("/list")))[0]).toContain("«Разделение» (2022)");

    const followed = texts(await send(callback({ type: "follow", tmdbId: 30 })));
    expect(followed[0]).toContain("автоматически попадут в календарь");
    expect(activeEvents(calendar).map((event) => event.date)).toEqual(["2026-12-05"]);
  });

  it("после «Смотрел» предлагает оценку и необязательное пояснение", async () => {
    expect(callbackData(await send(callback({ type: "watched", tmdbId: 30 })))).toEqual(["r:30:l", "r:30:d", "sc"]);
    await send(callback({ type: "rate", tmdbId: 30, rating: "liked" }));
    expect(texts(await send(message("Отличная атмосфера офиса")))).toEqual(["Пояснение сохранено."]);
    expect(test.store.getEntry(30)).toMatchObject({
      watched: true,
      rating: "liked",
      comment: "Отличная атмосфера офиса",
    });
  });

  it("повторный callback не меняет состояние повторно", async () => {
    await send(callback({ type: "follow", tmdbId: 30 }));
    expect(texts(await send(callback({ type: "follow", tmdbId: 30 })))[0]).toContain("уже следите");
    expect(calendar.calls).toEqual(["create ss30s2g1"]);

    await send(callback({ type: "want", tmdbId: 30 }));
    await send(callback({ type: "want", tmdbId: 30 }));
    expect(test.store.listEntries()).toHaveLength(1);

    expect(texts(await send(callback({ type: "confirm_profile" }))).join()).toContain("неактуален");
    expect(test.store.getProfile()).toBeNull();
  });
});

describe("Telegram: доступ", () => {
  it("чужой пользователь не получает ответа и не вызывает чтение данных и внешние запросы", async () => {
    expect(await send(message("/start", STRANGER, { ...PRIVATE, id: STRANGER.id }))).toEqual([]);
    expect(await send(callback({ type: "follow", tmdbId: 30 }, STRANGER))).toEqual([]);
    expect(test.store.getInterview()).toBeNull();
    expect(test.store.getSubscription(30)).toBeNull();
    expect(catalog.calls).toEqual([]);
  });

  it("сообщения владельца в групповом чате игнорируются", async () => {
    expect(await send(message("/following", OWNER, GROUP))).toEqual([]);
    expect(await send(message("/start", OWNER, GROUP))).toEqual([]);
    expect(test.store.getInterview()).toBeNull();
  });
});

describe("Telegram: ошибки", () => {
  it("ошибка доставки оставляет сообщение в очереди с понятной причиной", async () => {
    test.store.enqueue("premiere-check:1", [{ kind: "text", text: "Премьера сегодня" }], 0);
    failSend = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
    expect(await app.delivery.deliver()).toEqual({ sent: 0, error: "Telegram: доступ запрещён" });
    expect(test.store.countPending()).toBe(1);
  });

  it("сбой сценария показывает причину пользователю", async () => {
    catalog.failFor.add(30);
    const sent = texts(await send(callback({ type: "follow", tmdbId: 30 })));
    expect(sent).toEqual(["Не удалось выполнить: внутренняя ошибка приложения."]);
  });

  it("неизвестная кнопка и нетекстовое сообщение получают подсказку", async () => {
    expect(decodeAction("x:1")).toBeNull();
    expect(decodeAction("w:abc")).toBeNull();
    const voice = { update_id: ++updateId, message: { message_id: 1, date: 0, chat: PRIVATE, from: OWNER, voice: {} } };
    expect(texts(await send(voice as Update))).toEqual(["Я понимаю только текстовые сообщения."]);
  });
});
