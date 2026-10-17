const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Местное время `HH:MM`; с `weekday` — раз в неделю, без него — ежедневно. */
export type LocalSchedule = { readonly time: string; readonly weekday?: Weekday };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function localParts(format: Intl.DateTimeFormat, instantMs: number): LocalParts {
  const fields = Object.fromEntries(format.formatToParts(new Date(instantMs)).map(({ type, value }) => [type, value]));
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

function offsetAt(format: Intl.DateTimeFormat, instantMs: number): number {
  const local = localParts(format, instantMs);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - instantMs;
}

/** Моменты, в которые местные часы показывают `wallUtcMs`: ноль в разрыве перехода на летнее время, два — в повторе. */
function matchingInstants(format: Intl.DateTimeFormat, wallUtcMs: number): number[] {
  const desired = new Date(wallUtcMs);
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour++) offsets.add(offsetAt(format, wallUtcMs + hour * HOUR_MS));
  return [...offsets]
    .map((offset) => wallUtcMs - offset)
    .filter((instantMs) => {
      const actual = localParts(format, instantMs);
      return (
        actual.year === desired.getUTCFullYear() &&
        actual.month === desired.getUTCMonth() + 1 &&
        actual.day === desired.getUTCDate() &&
        actual.hour === desired.getUTCHours() &&
        actual.minute === desired.getUTCMinutes() &&
        actual.second === 0
      );
    });
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

/** Первое наступление расписания строго после `afterMs`. */
export function nextOccurrence(afterMs: number, schedule: LocalSchedule, timeZone: string): number {
  if (!isLocalTime(schedule.time)) throw new Error(`Некорректное местное время расписания: ${schedule.time}`);
  const format = formatter(timeZone);
  const local = localParts(format, afterMs);
  const hour = Number(schedule.time.slice(0, 2));
  const minute = Number(schedule.time.slice(3, 5));
  const localDayUtc = Date.UTC(local.year, local.month - 1, local.day);
  for (let day = 0; day <= 14; day++) {
    const wallUtcMs = localDayUtc + day * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS;
    if (schedule.weekday !== undefined && WEEKDAYS[new Date(wallUtcMs).getUTCDay()] !== schedule.weekday) continue;
    const next = matchingInstants(format, wallUtcMs)
      .filter((instantMs) => instantMs > afterMs)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) return next;
  }
  throw new Error(`Не найдено наступление расписания ${schedule.time} в зоне ${timeZone}`);
}
