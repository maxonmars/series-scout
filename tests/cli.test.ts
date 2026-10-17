import { describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from "../src/app/cli.ts";
import { createLogger } from "../src/app/logger.ts";
import type { NetworkProbe } from "../src/app/network-check.ts";
import { deepseekModelProbe } from "../src/app/network-check.ts";
import { type Environment, type InspectPath, readConfig, secretValues } from "../src/app/settings.ts";
import { ExternalServiceError } from "../src/application/errors.ts";

const SECRETS = {
  TELEGRAM_BOT_TOKEN: "123456789:AAFakeTelegramTokenValue_0123456789abc",
  DEEPSEEK_API_KEY: "sk-fake-deepseek-key-0123456789",
  TMDB_READ_ACCESS_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoidG1kYiJ9.ZmFrZS1zaWduYXR1cmU",
};

const COMPLETE_ENV: Environment = {
  ...SECRETS,
  TELEGRAM_OWNER_ID: "424242",
  GOOGLE_CALENDAR_ID: "series@group.calendar.google.com",
  GOOGLE_APPLICATION_CREDENTIALS: "/secrets/google.json",
  DATA_DIR: "/data",
  APP_TIME_ZONE: "Europe/Moscow",
  LLM_MODEL: "deepseek-flash",
};

const existingPaths: InspectPath = (path) => (path === "/data" ? "directory" : "readable-file");

async function run(
  args: readonly string[],
  env: Environment = {},
  options: { nodeVersion?: string; inspectPath?: InspectPath; networkProbes?: () => NetworkProbe[] } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    env,
    nodeVersion: options.nodeVersion ?? "24.16.0",
    inspectPath: options.inspectPath ?? (() => "missing"),
    output: { out: (text) => (stdout += text), err: (text) => (stderr += text) },
    onShutdown: () => {},
    networkProbes: options.networkProbes ?? (() => []),
  });
  return { code, stdout, stderr };
}

function line(stdout: string, name: string): string {
  return stdout.split("\n").find((text) => text.includes(`${name}:`)) ?? "";
}

describe("справка", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j выводит справку без настроек и завершается с кодом 0",
    async (args) => {
      const result = await run(args);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toContain("doctor");
      expect(result.stderr).toBe("");
    },
  );
});

describe("неизвестная команда", () => {
  it("завершается с кодом использования и называет команду в stderr", async () => {
    const result = await run(["recommend"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("Неизвестная команда: recommend");
    expect(result.stdout).toBe("");
  });

  it("неизвестный аргумент doctor и любой аргумент run считаются ошибкой использования", async () => {
    expect((await run(["doctor", "--json"])).code).toBe(EXIT_USAGE);
    expect((await run(["doctor", "--network", "--network"])).code).toBe(EXIT_USAGE);
    expect((await run(["run", "--now"])).code).toBe(EXIT_USAGE);
  });
});

describe("doctor", () => {
  it("без настроек перечисляет отсутствующие и завершается с ошибкой", async () => {
    const result = await run(["doctor"]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(line(result.stdout, "TELEGRAM_BOT_TOKEN")).toContain("не задано");
    expect(line(result.stdout, "GOOGLE_APPLICATION_CREDENTIALS")).toContain("не задано");
    expect(line(result.stdout, "APP_TIME_ZONE")).toContain("по умолчанию (Asia/Novosibirsk)");
    expect(result.stdout).toContain("не задано: 6");
  });

  it("пустое значение из скопированного .env.example считается отсутствующим", async () => {
    const result = await run(["doctor"], { ...COMPLETE_ENV, TELEGRAM_OWNER_ID: "" }, { inspectPath: existingPaths });
    expect(line(result.stdout, "TELEGRAM_OWNER_ID")).toContain("не задано");
    expect(result.code).toBe(EXIT_FAILURE);
  });

  it("отличает некорректное значение от отсутствующего", async () => {
    const env = {
      ...COMPLETE_ENV,
      TELEGRAM_OWNER_ID: "@owner",
      TMDB_READ_ACCESS_TOKEN: "0123456789abcdef0123456789abcdef",
      DEEPSEEK_API_KEY: undefined,
    };
    const result = await run(["doctor"], env, { inspectPath: existingPaths });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(line(result.stdout, "TELEGRAM_OWNER_ID")).toContain("некорректно — ожидается числовой id");
    expect(line(result.stdout, "TMDB_READ_ACCESS_TOKEN")).toContain("некорректно — ожидается API Read Access Token");
    expect(line(result.stdout, "DEEPSEEK_API_KEY")).toContain("не задано");
    expect(result.stdout).toContain("не задано: 1, некорректно: 2");
  });

  it("проверяет часовой пояс и пути без чтения файлов", async () => {
    const env = { ...COMPLETE_ENV, APP_TIME_ZONE: "Mars/Olympus", DATA_DIR: "/data/file.txt" };
    const result = await run(["doctor"], env, {
      inspectPath: (path) => (path === "/data/file.txt" ? "readable-file" : "missing"),
    });
    expect(line(result.stdout, "APP_TIME_ZONE")).toContain("некорректно — неизвестный часовой пояс");
    expect(line(result.stdout, "DATA_DIR")).toContain("некорректно — путь указывает не на каталог");
    expect(line(result.stdout, "GOOGLE_APPLICATION_CREDENTIALS")).toContain("некорректно — файл не найден");
  });

  it("с полной конфигурацией завершается успешно, но не заявляет о проверке соединений", async () => {
    const result = await run(["doctor"], COMPLETE_ENV, { inspectPath: existingPaths });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Telegram — соединение не проверено");
    expect(result.stdout).toContain("соединения не проверялись");
    expect(line(result.stdout, "TELEGRAM_BOT_TOKEN")).toMatch(/задано$/);
  });

  it("неподдерживаемая версия Node.js даёт ошибку даже при полной конфигурации", async () => {
    const result = await run(["doctor"], COMPLETE_ENV, { nodeVersion: "22.22.1", inspectPath: existingPaths });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toContain("22.22.1: не поддерживается, нужна 24.x");
  });
});

describe("секреты", () => {
  const privateValues = [
    ...Object.values(SECRETS),
    COMPLETE_ENV.TELEGRAM_OWNER_ID,
    COMPLETE_ENV.GOOGLE_CALENDAR_ID,
    COMPLETE_ENV.GOOGLE_APPLICATION_CREDENTIALS,
  ] as string[];

  it("корректные значения не попадают в вывод doctor", async () => {
    const result = await run(["doctor"], COMPLETE_ENV, { inspectPath: existingPaths });
    for (const value of privateValues) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it("некорректные значения не попадают в сообщения об ошибках", async () => {
    const invalid = {
      TELEGRAM_BOT_TOKEN: "not a token with spaces",
      DEEPSEEK_API_KEY: "sk leaked key",
      TMDB_READ_ACCESS_TOKEN: "tmdb-v3-key-not-a-jwt",
      GOOGLE_CALENDAR_ID: "private calendar",
    };
    const result = await run(["doctor"], { ...COMPLETE_ENV, ...invalid }, { inspectPath: () => "missing" });
    expect(result.code).toBe(EXIT_FAILURE);
    for (const value of [...Object.values(invalid), COMPLETE_ENV.GOOGLE_APPLICATION_CREDENTIALS] as string[]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });
});

describe("расписание", () => {
  it("по умолчанию: проверка в 09:00, подборка в воскресенье в 18:00", async () => {
    const result = await run(["doctor"]);
    expect(line(result.stdout, "PREMIERE_CHECK_TIME")).toContain("по умолчанию (09:00)");
    expect(line(result.stdout, "RECOMMENDATIONS_DAY")).toContain("по умолчанию (sunday)");
    expect(line(result.stdout, "RECOMMENDATIONS_TIME")).toContain("по умолчанию (18:00)");
  });

  it("отклоняет время не в формате ЧЧ:ММ и неизвестный день недели", async () => {
    const env = { ...COMPLETE_ENV, PREMIERE_CHECK_TIME: "9:00", RECOMMENDATIONS_DAY: "воскресенье" };
    const result = await run(["doctor"], env, { inspectPath: existingPaths });
    expect(line(result.stdout, "PREMIERE_CHECK_TIME")).toContain("некорректно — ожидается время ЧЧ:ММ");
    expect(line(result.stdout, "RECOMMENDATIONS_DAY")).toContain("некорректно — ожидается одно из: sunday");
  });

  it("передаёт расписание в конфигурацию запуска", () => {
    const env = { ...COMPLETE_ENV, PREMIERE_CHECK_TIME: "08:15", RECOMMENDATIONS_DAY: "friday" };
    const result = readConfig(env, existingPaths);
    expect(result.ok && result.config.schedules).toEqual({
      premiereCheck: { time: "08:15" },
      weeklyRecommendations: { time: "18:00", weekday: "friday" },
    });
  });
});

describe("doctor --network", () => {
  it("без полной конфигурации подключения не проверяет", async () => {
    let called = false;
    const result = await run(
      ["doctor", "--network"],
      {},
      {
        networkProbes: () => {
          called = true;
          return [];
        },
      },
    );
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toContain("Проверка подключений пропущена");
    expect(called).toBe(false);
  });

  it("сообщает результат каждого подключения и причину отказа без секретов", async () => {
    const result = await run(["doctor", "--network"], COMPLETE_ENV, {
      inspectPath: existingPaths,
      networkProbes: () => [
        { title: "Telegram", run: async () => "бот @series_scout_bot доступен" },
        {
          title: "TMDB",
          run: async () => {
            throw new ExternalServiceError("tmdb", "auth", 401);
          },
        },
        deepseekModelProbe(async () => ["deepseek-chat"], "deepseek-flash"),
      ],
    });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toContain("✓ Telegram: бот @series_scout_bot доступен");
    expect(result.stdout).toContain("✗ TMDB: ключ отклонён — проверьте TMDB_READ_ACCESS_TOKEN");
    expect(result.stdout).toContain(
      "✗ DeepSeek: ключ принят, но модель deepseek-flash недоступна; доступны: deepseek-chat",
    );
    for (const value of Object.values(SECRETS)) expect(result.stdout).not.toContain(value);
  });

  it("успешна, когда все подключения работают", async () => {
    const result = await run(["doctor", "--network"], COMPLETE_ENV, {
      inspectPath: existingPaths,
      networkProbes: () => [deepseekModelProbe(async () => ["deepseek-flash"], "deepseek-flash")],
    });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Итог: все подключения работают.");
  });
});

describe("run", () => {
  it("без настроек не запускается и перечисляет проблемы без значений", async () => {
    const result = await run(["run"], { TELEGRAM_BOT_TOKEN: "not a token with spaces" });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("✗ TELEGRAM_BOT_TOKEN: некорректно");
    expect(result.stderr).toContain("✗ DEEPSEEK_API_KEY: не задано");
    expect(result.stderr).not.toContain("not a token with spaces");
  });
});

describe("журнал", () => {
  it("заменяет значения секретов на ***", () => {
    let output = "";
    const logger = createLogger(
      (text) => (output += text),
      secretValues(COMPLETE_ENV),
      () => new Date(0),
    );
    logger.error(`запрос с ключом ${SECRETS.DEEPSEEK_API_KEY} и токеном ${SECRETS.TELEGRAM_BOT_TOKEN} не удался`);
    expect(output).toBe("1970-01-01T00:00:00.000Z ERROR запрос с ключом *** и токеном *** не удался\n");
  });
});
