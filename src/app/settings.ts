import { z } from "zod";

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
export function inspectSetting(setting: SettingDefinition, env: Environment, inspectPath: InspectPath): SettingStatus {
  const raw = env[setting.name];
  const value = raw === undefined || raw.trim() === "" ? setting.defaultValue : raw;
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
