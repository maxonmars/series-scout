import type { ServiceName } from "./errors.ts";
import { formatDateTime } from "./format.ts";
import type { HealthStore, JobRecord, OutboxStore, SubscriptionStore } from "./ports.ts";
import { JOB_PREMIERE_CHECK, JOB_WEEKLY_RECOMMENDATIONS } from "./scheduler.ts";

export type StatusDeps = {
  readonly health: HealthStore;
  readonly subscriptions: SubscriptionStore;
  readonly outbox: OutboxStore;
  readonly jobs: () => readonly JobRecord[];
  readonly calendarPending: () => number;
  readonly timeZone: string;
};

const SERVICES: readonly [ServiceName, string][] = [
  ["telegram", "Telegram"],
  ["tmdb", "TMDB"],
  ["deepseek", "DeepSeek"],
  ["google", "Google Calendar"],
];

const JOB_TITLES: Record<string, string> = {
  [JOB_PREMIERE_CHECK]: "Проверка премьер",
  [JOB_WEEKLY_RECOMMENDATIONS]: "Подборка недели",
};

/** Состояние по сохранённым результатам: `/status` сам внешние сервисы не опрашивает. */
export function renderStatus(deps: StatusDeps): string {
  const at = (ms: number) => formatDateTime(ms, deps.timeZone);
  const lines = ["Series Scout — состояние", "", "Подключения (по последним обращениям):"];

  const health = new Map(deps.health.listHealth().map((record) => [record.service, record]));
  for (const [service, title] of SERVICES) {
    const record = health.get(service);
    const parts: string[] = [];
    if (record?.lastSuccessAt) parts.push(`успешно ${at(record.lastSuccessAt)}`);
    if (record?.lastError && record.lastErrorAt) parts.push(`ошибка ${at(record.lastErrorAt)} — ${record.lastError}`);
    lines.push(`• ${title}: ${parts.length > 0 ? parts.join("; ") : "обращений ещё не было"}`);
  }

  lines.push("", "Задания:");
  for (const job of deps.jobs()) {
    const parts: string[] = [];
    if (job.lastSuccessAt) parts.push(`успешно ${at(job.lastSuccessAt)}`);
    if (job.lastError && job.lastErrorAt) parts.push(`ошибка ${at(job.lastErrorAt)} — ${job.lastError}`);
    if (parts.length === 0) parts.push("ещё не запускалось");
    parts.push(`следующий запуск ${at(job.nextRunAt)}`);
    lines.push(`• ${JOB_TITLES[job.name] ?? job.name}: ${parts.join("; ")}`);
  }

  const following = deps.subscriptions.listSubscriptions().filter((subscription) => subscription.active).length;
  lines.push(
    "",
    `Подписок: ${following}. Операций календаря в очереди: ${deps.calendarPending()}. Неотправленных сообщений: ${deps.outbox.countPending()}.`,
    `Часовой пояс: ${deps.timeZone}.`,
  );
  return lines.join("\n");
}
