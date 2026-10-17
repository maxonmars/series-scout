import type { Logger } from "../application/ports.ts";

/** Журнал в одну строку на событие; известные значения секретов заменяются на `***`. */
export function createLogger(
  write: (line: string) => void,
  secrets: readonly string[],
  now = () => new Date(),
): Logger {
  const redact = (message: string) => secrets.reduce((text, secret) => text.split(secret).join("***"), message);
  const line = (level: string, message: string) => write(`${now().toISOString()} ${level} ${redact(message)}\n`);
  return {
    info: (message) => line("INFO", message),
    error: (message) => line("ERROR", message),
  };
}
