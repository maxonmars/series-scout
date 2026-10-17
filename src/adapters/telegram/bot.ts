import { Api, Bot, type Context, GrammyError, HttpError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { type BotScenarios, COMMANDS, type CommandName } from "../../application/bot.ts";
import { describeError, describeForLog, ExternalServiceError, type FailureKind } from "../../application/errors.ts";
import type { ButtonAction, Logger, NotificationPort, OutgoingMessage } from "../../application/ports.ts";
import type { ReportHealth } from "../http.ts";
import { decodeAction, render } from "./render.ts";

export type TelegramBotOptions = {
  readonly token: string;
  readonly ownerId: number;
  readonly scenarios: BotScenarios;
  readonly logger: Logger;
  readonly reportHealth?: ReportHealth;
  /** Сведения о боте без запроса getMe — для тестов. */
  readonly botInfo?: UserFromGetMe;
};

const PROGRESS: Partial<Record<CommandName, string>> = {
  recommend: "Подбираю сериалы, это может занять до минуты…",
  sync: "Проверяю подписки и календарь…",
};

/** После этих действий кнопки сообщения убираются: повторное нажатие уже ничего не изменит. */
const ONE_SHOT: readonly ButtonAction["type"][] = [
  "pick_title",
  "skip_title",
  "finish_interview",
  "confirm_profile",
  "cancel_profile",
  "rate",
  "skip_comment",
];

function failureKind(error: unknown): FailureKind {
  if (error instanceof HttpError) return "unavailable";
  if (error instanceof GrammyError) {
    if (error.error_code === 401) return "auth";
    if (error.error_code === 403) return "forbidden";
    if (error.error_code === 429) return "rate_limit";
    if (error.error_code >= 500) return "unavailable";
    return "rejected";
  }
  return "unavailable";
}

const toServiceError = (error: unknown) =>
  new ExternalServiceError("telegram", failureKind(error), error instanceof GrammyError ? error.error_code : undefined);

export type TelegramBot = {
  readonly bot: Bot;
  readonly notifications: NotificationPort;
  /** Long polling; промис завершается после `stop`. */
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export function createTelegramBot(options: TelegramBotOptions): TelegramBot {
  const bot = new Bot(options.token, options.botInfo ? { botInfo: options.botInfo } : {});
  const { scenarios, logger } = options;

  async function send(chatId: number, message: OutgoingMessage): Promise<void> {
    const rendered = render(message);
    try {
      await bot.api.sendMessage(chatId, rendered.text, rendered.options);
      options.reportHealth?.("telegram", null);
    } catch (error) {
      const failure = toServiceError(error);
      options.reportHealth?.("telegram", failure);
      throw failure;
    }
  }

  async function reply(ctx: Context, work: () => Promise<OutgoingMessage[]>): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    let messages: OutgoingMessage[];
    try {
      messages = await work();
    } catch (error) {
      logger.error(`Ошибка обработки сообщения: ${describeForLog(error)}`);
      messages = [{ kind: "text", text: `Не удалось выполнить: ${describeError(error)}.` }];
    }
    for (const message of messages) await send(chatId, message);
  }

  // Проверка владельца выполняется до любых обработчиков: чужие обновления не читают данные и не вызывают API.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== options.ownerId || ctx.chat?.type !== "private") return;
    await next();
  });

  for (const [name] of COMMANDS) {
    bot.command(name, async (ctx) => {
      const progress = PROGRESS[name];
      if (progress) await send(ctx.chat.id, { kind: "text", text: progress });
      await reply(ctx, () => scenarios.command(name, ctx.match));
    });
  }

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const action = decodeAction(ctx.callbackQuery.data);
    if (action === null) {
      await reply(ctx, async () => [{ kind: "text", text: "Кнопка устарела. /help — список команд." }]);
      return;
    }
    if (ONE_SHOT.includes(action.type)) await ctx.editMessageReplyMarkup().catch(() => undefined);
    await reply(ctx, () => scenarios.action(action));
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await reply(ctx, async () => [{ kind: "text", text: "Неизвестная команда. /help — список команд." }]);
      return;
    }
    await reply(ctx, () => scenarios.text(ctx.message.text));
  });

  bot.on("message", async (ctx) => {
    await reply(ctx, async () => [{ kind: "text", text: "Я понимаю только текстовые сообщения." }]);
  });

  bot.catch((error) => {
    logger.error(`Ошибка Telegram-обработчика: ${describeForLog(toServiceError(error.error))}`);
  });

  return {
    bot,
    notifications: { send: (message) => send(options.ownerId, message) },

    async start() {
      try {
        await bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })));
        await bot.start({
          allowed_updates: ["message", "callback_query"],
          onStart: (info) => logger.info(`Telegram: бот @${info.username} получает обновления`),
        });
      } catch (error) {
        const failure = toServiceError(error);
        options.reportHealth?.("telegram", failure);
        throw failure;
      }
    },

    stop: () => bot.stop(),
  };
}

/** Проверка токена без запуска бота: имя бота из getMe. */
export async function verifyTelegramToken(token: string): Promise<string> {
  try {
    return (await new Api(token).getMe()).username;
  } catch (error) {
    throw toServiceError(error);
  }
}
