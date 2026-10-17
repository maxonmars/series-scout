import type { Delivery } from "./delivery.ts";
import type { Interview } from "./interview.ts";
import type { Library } from "./library.ts";
import type { ButtonAction, DialogStore, IdGenerator, OutgoingMessage } from "./ports.ts";
import type { Recommendations } from "./recommendations.ts";
import type { Serial } from "./serial.ts";
import type { Tracking } from "./tracking.ts";

export const COMMANDS = [
  ["start", "Знакомство или продолжение интервью"],
  ["profile", "Профиль предпочтений"],
  ["recommend", "Новая подборка"],
  ["search", "Поиск сериала по названию"],
  ["list", "Список «Хочу посмотреть»"],
  ["following", "Подписки и известные премьеры"],
  ["sync", "Проверить подписки и календарь сейчас"],
  ["status", "Состояние подключений и проверок"],
  ["help", "Справка"],
  ["about", "О продукте и источниках данных"],
] as const;

export type CommandName = (typeof COMMANDS)[number][0];

export const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

const HELP = [
  "Series Scout помогает выбирать сериалы по вашим предпочтениям и следит за премьерами новых сезонов.",
  "",
  ...COMMANDS.map(([name, description]) => `/${name} — ${description}`),
  "",
  "На карточках сериалов: «В список», «Смотрел», «Не интересно», «Следить за сезонами».",
  "Подписка добавляет будущие премьеры в отдельный Google-календарь; отписка удаляет будущие события.",
].join("\n");

const ABOUT = [
  "Series Scout — персональный помощник по сериалам.",
  "",
  "Сведения о сериалах и датах премьер — TMDB (themoviedb.org). Даты — оригинальные даты начала сезонов; если источник даты не знает, бот её не прогнозирует.",
  "Рекомендации и объяснения формирует модель DeepSeek по вашему профилю и описаниям из каталога.",
  "",
  `${TMDB_NOTICE}`,
  "Продукт использует TMDB API, но не одобрен и не сертифицирован TMDB.",
].join("\n");

export type BotDeps = {
  readonly interview: Interview;
  readonly library: Library;
  readonly tracking: Tracking;
  readonly recommendations: Recommendations;
  readonly delivery: Delivery;
  readonly dialog: DialogStore;
  readonly status: () => string;
  readonly newId: IdGenerator;
  readonly serial: Serial;
};

const text = (value: string): OutgoingMessage => ({ kind: "text", text: value });

/** Сценарии бота без привязки к Telegram: команды, кнопки и свободный текст. */
export function createBotScenarios(deps: BotDeps) {
  async function recommend(): Promise<OutgoingMessage[]> {
    const result = await deps.serial("recommendations", () => deps.recommendations.recommend(`manual:${deps.newId()}`));
    if (result.status === "no_profile") return [text("Сначала расскажите о предпочтениях: /start.")];
    const delivery = await deps.delivery.deliver();
    if (delivery.error !== null)
      return [text(`Подборка сохранена, но отправить её не удалось: ${delivery.error}. Повторю позже.`)];
    return [];
  }

  async function sync(): Promise<OutgoingMessage[]> {
    const result = await deps.tracking.checkAll(`manual:${deps.newId()}`);
    await deps.delivery.deliver();
    const lines = [
      `Проверено подписок: ${result.checked}. ${result.changes > 0 ? `Изменений: ${result.changes}.` : "Изменений нет."}`,
      ...result.failures.map((failure) => `Не удалось проверить ${failure.name}: ${failure.reason}.`),
      result.calendar.error === null
        ? "Календарь синхронизирован."
        : `Календарь: в очереди ${result.calendar.pending} операций — ${result.calendar.error}.`,
    ];
    return [text(lines.join("\n"))];
  }

  return {
    async command(name: CommandName, args: string): Promise<OutgoingMessage[]> {
      deps.dialog.setPendingInput(null);
      switch (name) {
        case "start":
          return deps.interview.start();
        case "profile":
          return deps.interview.showProfile();
        case "recommend":
          return recommend();
        case "search":
          return args.trim() === "" ? deps.library.askSearchQuery() : deps.library.search(args.trim());
        case "list":
          return deps.library.list();
        case "following":
          return deps.tracking.following();
        case "sync":
          return sync();
        case "status":
          return [text(deps.status())];
        case "help":
          return [text(HELP)];
        case "about":
          return [text(ABOUT)];
      }
    },

    async action(action: ButtonAction): Promise<OutgoingMessage[]> {
      switch (action.type) {
        case "want":
          return deps.library.addToList(action.tmdbId);
        case "watched":
          return deps.library.markWatched(action.tmdbId);
        case "not_interested":
          return deps.library.notInterested(action.tmdbId);
        case "rate":
          return deps.library.rate(action.tmdbId, action.rating);
        case "skip_comment":
          return deps.library.skipComment();
        case "follow":
          return deps.tracking.follow(action.tmdbId);
        case "unfollow":
          return deps.tracking.unfollow(action.tmdbId);
        case "pick_title":
          return deps.interview.pickTitle(action.tmdbId);
        case "skip_title":
          return deps.interview.skipTitle();
        case "finish_interview":
          return deps.interview.finish();
        case "confirm_profile":
          return deps.interview.confirm();
        case "cancel_profile":
          return deps.interview.cancel();
        case "edit_profile":
          return deps.interview.edit();
      }
    },

    async text(message: string): Promise<OutgoingMessage[]> {
      const pending = deps.dialog.getPendingInput();
      if (pending?.kind === "search") return deps.library.search(message);
      if (pending?.kind === "comment") return deps.library.comment(pending.tmdbId, message);
      if (deps.interview.isActive()) return deps.interview.handleText(message);
      return [text("Не понял сообщение. /search — найти сериал, /help — все команды.")];
    },
  };
}

export type BotScenarios = ReturnType<typeof createBotScenarios>;
