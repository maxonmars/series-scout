import { describe, expect, it } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from "../src/app/cli.ts";
import type { Environment, InspectPath } from "../src/app/settings.ts";

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

function run(
  args: readonly string[],
  env: Environment = {},
  options: { nodeVersion?: string; inspectPath?: InspectPath } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, {
    env,
    nodeVersion: options.nodeVersion ?? "24.16.0",
    inspectPath: options.inspectPath ?? (() => "missing"),
    output: { out: (text) => (stdout += text), err: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

function line(stdout: string, name: string): string {
  return stdout.split("\n").find((text) => text.includes(`${name}:`)) ?? "";
}

describe("справка", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j выводит справку без настроек и завершается с кодом 0",
    (args) => {
      const result = run(args);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toContain("doctor");
      expect(result.stderr).toBe("");
    },
  );
});

describe("неизвестная команда", () => {
  it("завершается с кодом использования и называет команду в stderr", () => {
    const result = run(["recommend"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("Неизвестная команда: recommend");
    expect(result.stdout).toBe("");
  });

  it("лишний аргумент doctor тоже считается ошибкой использования", () => {
    expect(run(["doctor", "--network"]).code).toBe(EXIT_USAGE);
  });
});

describe("doctor", () => {
  it("без настроек перечисляет отсутствующие и завершается с ошибкой", () => {
    const result = run(["doctor"]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(line(result.stdout, "TELEGRAM_BOT_TOKEN")).toContain("не задано");
    expect(line(result.stdout, "GOOGLE_APPLICATION_CREDENTIALS")).toContain("не задано");
    expect(line(result.stdout, "APP_TIME_ZONE")).toContain("по умолчанию (Asia/Novosibirsk)");
    expect(result.stdout).toContain("не задано: 6");
  });

  it("пустое значение из скопированного .env.example считается отсутствующим", () => {
    const result = run(["doctor"], { ...COMPLETE_ENV, TELEGRAM_OWNER_ID: "" }, { inspectPath: existingPaths });
    expect(line(result.stdout, "TELEGRAM_OWNER_ID")).toContain("не задано");
    expect(result.code).toBe(EXIT_FAILURE);
  });

  it("отличает некорректное значение от отсутствующего", () => {
    const env = {
      ...COMPLETE_ENV,
      TELEGRAM_OWNER_ID: "@owner",
      TMDB_READ_ACCESS_TOKEN: "0123456789abcdef0123456789abcdef",
      DEEPSEEK_API_KEY: undefined,
    };
    const result = run(["doctor"], env, { inspectPath: existingPaths });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(line(result.stdout, "TELEGRAM_OWNER_ID")).toContain("некорректно — ожидается числовой id");
    expect(line(result.stdout, "TMDB_READ_ACCESS_TOKEN")).toContain("некорректно — ожидается API Read Access Token");
    expect(line(result.stdout, "DEEPSEEK_API_KEY")).toContain("не задано");
    expect(result.stdout).toContain("не задано: 1, некорректно: 2");
  });

  it("проверяет часовой пояс и пути без чтения файлов", () => {
    const env = { ...COMPLETE_ENV, APP_TIME_ZONE: "Mars/Olympus", DATA_DIR: "/data/file.txt" };
    const result = run(["doctor"], env, {
      inspectPath: (path) => (path === "/data/file.txt" ? "readable-file" : "missing"),
    });
    expect(line(result.stdout, "APP_TIME_ZONE")).toContain("некорректно — неизвестный часовой пояс");
    expect(line(result.stdout, "DATA_DIR")).toContain("некорректно — путь указывает не на каталог");
    expect(line(result.stdout, "GOOGLE_APPLICATION_CREDENTIALS")).toContain("некорректно — файл не найден");
  });

  it("с полной конфигурацией завершается успешно, но не заявляет о проверке соединений", () => {
    const result = run(["doctor"], COMPLETE_ENV, { inspectPath: existingPaths });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Telegram — соединение не проверено");
    expect(result.stdout).toContain("соединения не проверялись");
    expect(line(result.stdout, "TELEGRAM_BOT_TOKEN")).toMatch(/задано$/);
  });

  it("неподдерживаемая версия Node.js даёт ошибку даже при полной конфигурации", () => {
    const result = run(["doctor"], COMPLETE_ENV, { nodeVersion: "22.22.1", inspectPath: existingPaths });
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

  it("корректные значения не попадают в вывод doctor", () => {
    const result = run(["doctor"], COMPLETE_ENV, { inspectPath: existingPaths });
    for (const value of privateValues) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it("некорректные значения не попадают в сообщения об ошибках", () => {
    const invalid = {
      TELEGRAM_BOT_TOKEN: "not a token with spaces",
      DEEPSEEK_API_KEY: "sk leaked key",
      TMDB_READ_ACCESS_TOKEN: "tmdb-v3-key-not-a-jwt",
      GOOGLE_CALENDAR_ID: "private calendar",
    };
    const result = run(["doctor"], { ...COMPLETE_ENV, ...invalid }, { inspectPath: () => "missing" });
    expect(result.code).toBe(EXIT_FAILURE);
    for (const value of [...Object.values(invalid), COMPLETE_ENV.GOOGLE_APPLICATION_CREDENTIALS] as string[]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });
});
