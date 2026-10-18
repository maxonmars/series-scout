import { createDeepSeekTasteModel } from "../adapters/deepseek/taste-model.ts";
import { createGoogleCalendar } from "../adapters/google/calendar.ts";
import { verifyTelegramToken } from "../adapters/telegram/bot.ts";
import { createTmdbCatalog } from "../adapters/tmdb/catalog.ts";
import { describeError, OperationError } from "../application/errors.ts";
import type { AppConfig } from "./settings.ts";

/** Проверка одного подключения: возвращает описание успеха или бросает ошибку. */
export type NetworkProbe = { readonly title: string; readonly run: () => Promise<string> };

export type NetworkReport = { readonly text: string; readonly ok: boolean };

export async function runNetworkCheck(probes: readonly NetworkProbe[]): Promise<NetworkReport> {
  const lines = ["Проверка подключений"];
  let ok = true;
  for (const probe of probes) {
    try {
      lines.push(`  ✓ ${probe.title}: ${await probe.run()}`);
    } catch (error) {
      ok = false;
      const reason = describeError(error);
      const prefix = `${probe.title}: `;
      lines.push(`  ✗ ${probe.title}: ${reason.startsWith(prefix) ? reason.slice(prefix.length) : reason}`);
    }
  }
  lines.push("", ok ? "Итог: все подключения работают." : "Итог: есть недоступные подключения.");
  return { text: `${lines.join("\n")}\n`, ok };
}

export function deepseekModelProbe(listModels: () => Promise<string[]>, model: string): NetworkProbe {
  return {
    title: "DeepSeek",
    async run() {
      const models = await listModels();
      if (!models.includes(model)) {
        throw new OperationError(`ключ принят, но модель ${model} недоступна; доступны: ${models.join(", ")}`);
      }
      return `ключ принят, модель ${model} доступна`;
    },
  };
}

const noCache = { getCachedResponse: () => null, saveCachedResponse: () => {} };

/** Пробы с настоящими адаптерами; запросы только читают данные. */
export function networkProbes(config: AppConfig): NetworkProbe[] {
  const tmdb = createTmdbCatalog({ readAccessToken: config.tmdb.readAccessToken, cache: noCache, now: Date.now });
  const deepseek = createDeepSeekTasteModel({
    apiKey: config.deepseek.apiKey,
    model: config.deepseek.model,
    prompts: { interview: "", ranking: "" },
  });
  const google = createGoogleCalendar(config.google);
  return [
    { title: "Telegram", run: async () => `бот @${await verifyTelegramToken(config.telegram.token)} доступен` },
    {
      title: "TMDB",
      async run() {
        await tmdb.verifyAccess();
        return "токен принят";
      },
    },
    deepseekModelProbe(deepseek.listModels, config.deepseek.model),
    {
      title: "Google Calendar",
      async run() {
        await google.verifyAccess();
        return "календарь доступен; право изменять события проверяется при первой синхронизации";
      },
    },
  ];
}
