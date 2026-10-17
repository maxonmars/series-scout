import { type LocalSchedule, nextOccurrence } from "../domain/schedule.ts";
import { describeError, describeForLog } from "./errors.ts";
import type { Clock, JobRecord, JobStore, Logger } from "./ports.ts";

export type JobDefinition = {
  readonly name: string;
  readonly schedule: LocalSchedule;
  /** `scheduledAt` — срок запуска: по нему строятся ключи идемпотентности результата. */
  readonly run: (scheduledAt: number) => Promise<void>;
};

export type SchedulerDeps = {
  readonly jobs: readonly JobDefinition[];
  readonly store: JobStore;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly logger: Logger;
  /** Обслуживание на каждом такте: доставка очереди и незавершённые операции календаря. */
  readonly maintenance: () => Promise<void>;
};

export const JOB_PREMIERE_CHECK = "premiere-check";
export const JOB_WEEKLY_RECOMMENDATIONS = "weekly-recommendations";

const describeSchedule = (schedule: LocalSchedule, timeZone: string) =>
  `${schedule.weekday ?? "daily"} ${schedule.time} ${timeZone}`;

/**
 * После простоя просроченное задание выполняется один раз, следующий срок считается от момента запуска.
 * Срок сохраняется до выполнения: перезапуск посреди задания повторит его с тем же `scheduledAt`.
 */
export function createScheduler(deps: SchedulerDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  let stopped = false;

  function ensureJob(job: JobDefinition, now: number): JobRecord {
    const schedule = describeSchedule(job.schedule, deps.timeZone);
    const record = deps.store.getJob(job.name);
    if (record && record.schedule === schedule) return record;
    const fresh: JobRecord = {
      name: job.name,
      schedule,
      nextRunAt: nextOccurrence(now, job.schedule, deps.timeZone),
      lastStartedAt: record?.lastStartedAt ?? null,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      lastError: record?.lastError ?? null,
      lastErrorAt: record?.lastErrorAt ?? null,
    };
    deps.store.saveJob(fresh);
    return fresh;
  }

  async function runJob(job: JobDefinition, record: JobRecord): Promise<void> {
    const startedAt = deps.clock.now();
    deps.store.saveJob({ ...record, lastStartedAt: startedAt });
    const nextRunAt = nextOccurrence(startedAt, job.schedule, deps.timeZone);
    try {
      await job.run(record.nextRunAt);
      deps.store.saveJob({ ...record, lastStartedAt: startedAt, lastSuccessAt: deps.clock.now(), nextRunAt });
    } catch (error) {
      const reason = describeError(error);
      deps.logger.error(`Задание ${job.name} завершилось ошибкой: ${describeForLog(error)}`);
      deps.store.saveJob({
        ...record,
        lastStartedAt: startedAt,
        lastError: reason,
        lastErrorAt: deps.clock.now(),
        nextRunAt,
      });
    }
  }

  async function tick(): Promise<void> {
    for (const job of deps.jobs) {
      const record = ensureJob(job, deps.clock.now());
      if (record.nextRunAt <= deps.clock.now()) await runJob(job, record);
    }
    try {
      await deps.maintenance();
    } catch (error) {
      deps.logger.error(`Обслуживание очереди завершилось ошибкой: ${describeForLog(error)}`);
    }
  }

  return {
    tick,

    start(intervalMs: number): void {
      stopped = false;
      const loop = () => {
        current = tick()
          .catch((error: unknown) =>
            deps.logger.error(`Такт планировщика завершился ошибкой: ${describeForLog(error)}`),
          )
          .finally(() => {
            current = undefined;
            if (!stopped) timer = setTimeout(loop, intervalMs);
          });
      };
      loop();
    },

    /** Останавливает такты и дожидается текущего. */
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await current;
    },

    jobs: () => deps.jobs.map((job) => ensureJob(job, deps.clock.now())),
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
