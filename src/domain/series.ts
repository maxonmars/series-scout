import type { IsoDate } from "./dates.ts";

/** Сериал каталога. `overview` — русское описание, при его отсутствии английское; `null`, если нет никакого. */
export type SeriesSummary = {
  readonly tmdbId: number;
  readonly name: string;
  readonly originalName: string;
  readonly firstAirDate: IsoDate | null;
  readonly year: number | null;
  readonly overview: string | null;
  readonly genreIds: readonly number[];
};

/** Сезон с датой начала; `null` — дата пока неизвестна. Сезон 0 (спецвыпуски) сюда не попадает. */
export type Season = { readonly number: number; readonly airDate: IsoDate | null };

export type SeriesDetails = SeriesSummary & { readonly seasons: readonly Season[] };

export const seriesUrl = (tmdbId: number): string => `https://www.themoviedb.org/tv/${tmdbId}`;

export function displayName(series: { readonly name: string; readonly year: number | null }): string {
  return series.year === null ? `«${series.name}»` : `«${series.name}» (${series.year})`;
}

/** Ближайший сезон с известной датой начала в интервале `[from, to]`. */
export function upcomingSeason(seasons: readonly Season[], from: IsoDate, to: IsoDate): Season | null {
  const upcoming = seasons
    .filter((season) => season.airDate !== null && season.airDate >= from && season.airDate <= to)
    .sort((a, b) => (a.airDate ?? "").localeCompare(b.airDate ?? ""));
  return upcoming[0] ?? null;
}
