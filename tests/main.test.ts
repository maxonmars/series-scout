import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = resolve("src/app/main.ts");

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "series-scout-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function run(args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [MAIN, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("точка входа", () => {
  it("показывает справку в пустом окружении без .env", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("doctor");
    expect(result.stderr).toBe("");
  });

  it("возвращает ненулевой код процесса для неизвестной команды", () => {
    const result = run(["start-bot"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Неизвестная команда: start-bot");
  });

  it("берёт настройки из .env рабочего каталога, окружение процесса имеет приоритет", () => {
    writeFileSync(join(cwd, ".env"), "TELEGRAM_OWNER_ID=not-a-number\nAPP_TIME_ZONE=Mars/Olympus\n");
    const result = run(["doctor"], { APP_TIME_ZONE: "Europe/Moscow" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("TELEGRAM_OWNER_ID: некорректно");
    expect(result.stdout).toContain("APP_TIME_ZONE: задано (Europe/Moscow)");
  });

  it("проверяет реальный файл credentials без вывода его содержимого", () => {
    const credentials = join(cwd, "google.json");
    writeFileSync(credentials, '{"private_key":"-----BEGIN FAKE KEY-----"}');
    mkdirSync(join(cwd, "data"));
    const result = run(["doctor"], { GOOGLE_APPLICATION_CREDENTIALS: credentials, DATA_DIR: join(cwd, "data") });
    expect(result.stdout).toContain("GOOGLE_APPLICATION_CREDENTIALS: задано");
    expect(result.stdout).toContain(`DATA_DIR: задано (${join(cwd, "data")})`);
    expect(result.stdout).not.toContain("BEGIN FAKE KEY");
  });

  it.skipIf(process.getuid?.() === 0)("сообщает о файле credentials без прав на чтение", () => {
    const credentials = join(cwd, "google.json");
    writeFileSync(credentials, "{}");
    chmodSync(credentials, 0o000);
    const result = run(["doctor"], { GOOGLE_APPLICATION_CREDENTIALS: credentials });
    expect(result.stdout).toContain("GOOGLE_APPLICATION_CREDENTIALS: некорректно — нет прав на чтение файла");
  });
});
