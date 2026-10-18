import type { IsoDate } from "../domain/dates.ts";

/** «17 января 2027»: календарная дата выводится как есть, без пересчёта в часовой пояс. */
export function formatDate(date: IsoDate): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .replace(/\s*г\.$/, "");
}

export function formatDateTime(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instantMs));
}
