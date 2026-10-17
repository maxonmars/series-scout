import type { LocalSchedule } from "../domain/schedule.ts";
import type { Delivery } from "./delivery.ts";
import { OperationError } from "./errors.ts";
import type { Recommendations } from "./recommendations.ts";
import { JOB_PREMIERE_CHECK, JOB_WEEKLY_RECOMMENDATIONS, type JobDefinition } from "./scheduler.ts";
import type { Serial } from "./serial.ts";
import type { Tracking } from "./tracking.ts";

export type JobsDeps = {
  readonly tracking: Tracking;
  readonly recommendations: Recommendations;
  readonly delivery: Delivery;
  readonly serial: Serial;
  readonly premiereCheck: LocalSchedule;
  readonly weeklyRecommendations: LocalSchedule;
};

/** Частичный сбой проверки отмечается ошибкой задания, но остальные сериалы уже обработаны. */
export function createJobs(deps: JobsDeps): JobDefinition[] {
  return [
    {
      name: JOB_PREMIERE_CHECK,
      schedule: deps.premiereCheck,
      async run(scheduledAt) {
        const result = await deps.tracking.checkAll(`daily:${scheduledAt}`);
        await deps.delivery.deliver();
        const problems = [
          ...result.failures.map((failure) => `${failure.name}: ${failure.reason}`),
          ...(result.calendar.error === null ? [] : [`календарь: ${result.calendar.error}`]),
        ];
        if (problems.length > 0) throw new OperationError(problems.join("; "));
      },
    },
    {
      name: JOB_WEEKLY_RECOMMENDATIONS,
      schedule: deps.weeklyRecommendations,
      async run(scheduledAt) {
        await deps.serial("recommendations", () => deps.recommendations.recommend(`weekly:${scheduledAt}`));
        await deps.delivery.deliver();
      },
    },
  ];
}
