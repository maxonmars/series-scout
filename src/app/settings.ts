import { z } from "zod";
import { isLocalTime, type LocalSchedule, WEEKDAYS } from "../domain/schedule.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

export type PathState = "missing" | "directory" | "readable-file" | "unreadable-file" | "other" | "inaccessible";

export type InspectPath = (path: string) => PathState;

export type SettingStatus =
  | { readonly kind: "set"; readonly shown?: string }
  | { readonly kind: "default"; readonly shown: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string };

type SettingDefinition = {
  readonly name: string;
  /** Значение можно показывать в диагностике; остальные выводятся только как «задано». */
  readonly public?: boolean;
  readonly defaultValue?: string;
  readonly schema: z.ZodType<string>;
  readonly path?: "file" | "directory";
};

export type SettingGroup = {
  readonly title: string;
  readonly integration: boolean;
  readonly settings: readonly SettingDefinition[];
};

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const withoutSpaces = (reason: string) => z.string().regex(/^\S+$/, reason);
const localTime = z.string().refine(isLocalTime, "ожидается время ЧЧ:ММ, например 09:00");

export const settingGroups: readonly SettingGroup[] = [
  {
    title: "Общие",
    integration: false,
    settings: [
      { name: "DATA_DIR", public: true, defaultValue: "./.local", schema: z.string(), path: "directory" },
      {
        name: "APP_TIME_ZONE",
        public: true,
        defaultValue: "Asia/Novosibirsk",
        schema: z.string().refine(isTimeZone, "неизвестный часовой пояс IANA, ожидается вида Asia/Novosibirsk"),
      },
    ],
  },
  {
    title: "Расписание",
    integration: false,
    settings: [
      { name: "PREMIERE_CHECK_TIME", public: true, defaultValue: "09:00", schema: localTime },
      {
        name: "RECOMMENDATIONS_DAY",
        public: true,
        defaultValue: "sunday",
        schema: z
          .string()
          .refine((value) => WEEKDAYS.some((day) => day === value), `ожидается одно из: ${WEEKDAYS.join(", ")}`),
      },
      { name: "RECOMMENDATIONS_TIME", public: true, defaultValue: "18:00", schema: localTime },
    ],
  },
  {
    title: "Telegram",
    integration: true,
    settings: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        schema: z.string().regex(/^\d+:[\w-]{30,}$/, "ожидается токен от @BotFather вида <число>:<строка>"),
      },
      {
        name: "TELEGRAM_OWNER_ID",
        schema: z.string().regex(/^[1-9]\d*$/, "ожидается числовой id пользователя Telegram"),
      },
    ],
  },
  {
    title: "DeepSeek",
    integration: true,
    settings: [
      { name: "DEEPSEEK_API_KEY", schema: withoutSpaces("ключ содержит пробельные символы") },
      {
        name: "LLM_MODEL",
        public: true,
        defaultValue: "deepseek-flash",
        schema: withoutSpaces("имя модели содержит пробельные символы"),
      },
    ],
  },
  {
    title: "TMDB",
    integration: true,
    settings: [
      {
        name: "TMDB_READ_ACCESS_TOKEN",
        // API Key v3 (32 hex-символа) сюда не подходит: нужен Read Access Token v4 в формате JWT.
        schema: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, "ожидается API Read Access Token (JWT), а не API Key"),
      },
    ],
  },
  {
    title: "Google Calendar",
    integration: true,
    settings: [
      {
        name: "GOOGLE_CALENDAR_ID",
        schema: z.string().regex(/^[^\s@]+@[^\s@]+$/, "ожидается идентификатор вида …@group.calendar.google.com"),
      },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", schema: z.string(), path: "file" },
    ],
  },
];

function checkPath(kind: "file" | "directory", state: PathState): SettingStatus | undefined {
  if (kind === "file") {
    if (state === "readable-file") return undefined;
    if (state === "missing") return { kind: "invalid", reason: "файл не найден" };
    if (state === "unreadable-file") return { kind: "invalid", reason: "нет прав на чтение файла" };
    if (state === "directory") return { kind: "invalid", reason: "путь указывает на каталог, а не на файл" };
    if (state === "inaccessible") return { kind: "invalid", reason: "нет доступа к пути" };
    return { kind: "invalid", reason: "путь указывает не на обычный файл" };
  }
  if (state === "directory" || state === "missing") return undefined;
  if (state === "inaccessible") return { kind: "invalid", reason: "нет доступа к пути" };
  return { kind: "invalid", reason: "путь указывает не на каталог" };
}

/** Пустая строка считается отсутствующим значением: так выглядит .env, скопированный из .env.example. */
function settingValue(setting: SettingDefinition, env: Environment): string | undefined {
  const raw = env[setting.name];
  return raw === undefined || raw.trim() === "" ? setting.defaultValue : raw;
}

export function inspectSetting(setting: SettingDefinition, env: Environment, inspectPath: InspectPath): SettingStatus {
  const raw = env[setting.name];
  const value = settingValue(setting, env);
  if (value === undefined) return { kind: "missing" };

  const parsed = setting.schema.safeParse(value);
  if (!parsed.success) return { kind: "invalid", reason: parsed.error.issues[0]?.message ?? "некорректное значение" };

  if (setting.path) {
    const problem = checkPath(setting.path, inspectPath(value));
    if (problem) return problem;
  }

  const shown = setting.public ? value : undefined;
  if (value !== raw) return { kind: "default", shown: value };
  return shown === undefined ? { kind: "set" } : { kind: "set", shown };
}

export type AppConfig = {
  readonly dataDir: string;
  readonly timeZone: string;
  readonly schedules: { readonly premiereCheck: LocalSchedule; readonly weeklyRecommendations: LocalSchedule };
  readonly telegram: { readonly token: string; readonly ownerId: number };
  readonly deepseek: { readonly apiKey: string; readonly model: string };
  readonly tmdb: { readonly readAccessToken: string };
  readonly google: { readonly calendarId: string; readonly credentialsPath: string };
};

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Полная конфигурация для запуска; при ошибках — их список без значений настроек. */
export function readConfig(env: Environment, inspectPath: InspectPath): ConfigResult {
  const problems: string[] = [];
  const values = new Map<string, string>();
  for (const setting of settingGroups.flatMap((group) => group.settings)) {
    const status = inspectSetting(setting, env, inspectPath);
    if (status.kind === "missing") problems.push(`${setting.name}: не задано`);
    else if (status.kind === "invalid") problems.push(`${setting.name}: некорректно — ${status.reason}`);
    else values.set(setting.name, settingValue(setting, env) ?? "");
  }
  if (problems.length > 0) return { ok: false, problems };

  const value = (name: string) => values.get(name) ?? "";
  const weekday = WEEKDAYS.find((day) => day === value("RECOMMENDATIONS_DAY")) ?? "sunday";
  return {
    ok: true,
    config: {
      dataDir: value("DATA_DIR"),
      timeZone: value("APP_TIME_ZONE"),
      schedules: {
        premiereCheck: { time: value("PREMIERE_CHECK_TIME") },
        weeklyRecommendations: { time: value("RECOMMENDATIONS_TIME"), weekday },
      },
      telegram: { token: value("TELEGRAM_BOT_TOKEN"), ownerId: Number(value("TELEGRAM_OWNER_ID")) },
      deepseek: { apiKey: value("DEEPSEEK_API_KEY"), model: value("LLM_MODEL") },
      tmdb: { readAccessToken: value("TMDB_READ_ACCESS_TOKEN") },
      google: { calendarId: value("GOOGLE_CALENDAR_ID"), credentialsPath: value("GOOGLE_APPLICATION_CREDENTIALS") },
    },
  };
}

/** Значения секретов для маскировки в журнале. */
export function secretValues(env: Environment): string[] {
  return settingGroups
    .flatMap((group) => group.settings)
    .filter((setting) => !setting.public)
    .map((setting) => env[setting.name]?.trim() ?? "")
    .filter((value) => value.length >= 4);
}
