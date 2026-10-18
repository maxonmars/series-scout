import { z } from "zod";
import { ExternalServiceError } from "../../application/errors.ts";
import type { CatalogPort, DiscoverQuery } from "../../application/ports.ts";
import { type IsoDate, isIsoDate, yearOf } from "../../domain/dates.ts";
import type { Season, SeriesDetails, SeriesSummary } from "../../domain/series.ts";
import { createHttpClient, type HttpClientOptions } from "../http.ts";

const BASE_URL = "https://api.themoviedb.org/3";
const LANGUAGE = "ru-RU";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Кэш ответов каталога; реализуется хранилищем приложения. */
export type ResponseCache = {
  readonly getCachedResponse: (key: string, notOlderThan: number) => string | null;
  readonly saveCachedResponse: (key: string, body: string, at: number) => void;
};

export type TmdbCatalogOptions = Omit<HttpClientOptions, "service"> & {
  readonly readAccessToken: string;
  readonly cache: ResponseCache;
  readonly now: () => number;
  readonly baseUrl?: string;
};

const text = z.string().nullish();

const listItem = z.object({
  id: z.number().int(),
  name: text,
  original_name: text,
  first_air_date: text,
  overview: text,
  genre_ids: z.array(z.number().int()).nullish(),
});

const listResponse = z.object({ results: z.array(listItem) });

const details = z.object({
  id: z.number().int(),
  name: text,
  original_name: text,
  first_air_date: text,
  overview: text,
  genres: z.array(z.object({ id: z.number().int() })).nullish(),
  seasons: z.array(z.object({ season_number: z.number().int(), air_date: text })).nullish(),
  translations: z
    .object({
      translations: z.array(
        z.object({ iso_639_1: z.string(), data: z.object({ overview: text, name: text }).nullish() }),
      ),
    })
    .nullish(),
});

const season = z.object({ air_date: text });
const authentication = z.object({ success: z.boolean() });

/** Пустая строка в датах TMDB означает «неизвестна». */
function toDate(value: string | null | undefined): IsoDate | null {
  return value && isIsoDate(value) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toSummary(item: z.infer<typeof listItem>): SeriesSummary {
  const originalName = nonEmpty(item.original_name) ?? nonEmpty(item.name) ?? `TMDB ${item.id}`;
  const firstAirDate = toDate(item.first_air_date);
  return {
    tmdbId: item.id,
    name: nonEmpty(item.name) ?? originalName,
    originalName,
    firstAirDate,
    year: yearOf(firstAirDate),
    overview: nonEmpty(item.overview),
    genreIds: item.genre_ids ?? [],
  };
}

function toDetails(body: z.infer<typeof details>): SeriesDetails {
  const english = body.translations?.translations.find((translation) => translation.iso_639_1 === "en");
  const summary = toSummary({ ...body, genre_ids: body.genres?.map((genre) => genre.id) ?? [] });
  const seasons: Season[] = (body.seasons ?? [])
    .filter((item) => item.season_number > 0)
    .map((item) => ({ number: item.season_number, airDate: toDate(item.air_date) }))
    .sort((a, b) => a.number - b.number);
  return { ...summary, overview: summary.overview ?? nonEmpty(english?.data?.overview), seasons };
}

export type TmdbCatalog = CatalogPort & { readonly verifyAccess: () => Promise<void> };

export function createTmdbCatalog(options: TmdbCatalogOptions): TmdbCatalog {
  const http = createHttpClient({ ...options, service: "tmdb" });
  const baseUrl = options.baseUrl ?? BASE_URL;

  async function get<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
    { fresh }: { fresh: boolean },
  ): Promise<T> {
    const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const key = `${path}?${query}`;
    const now = options.now();
    if (!fresh) {
      const cached = options.cache.getCachedResponse(key, now - CACHE_TTL_MS);
      const parsed = cached === null ? undefined : schema.safeParse(JSON.parse(cached));
      if (parsed?.success) return parsed.data;
    }
    const response = await http(`${baseUrl}${key}`, {
      headers: { authorization: `Bearer ${options.readAccessToken}` },
    });
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) throw new ExternalServiceError("tmdb", "invalid_response", response.status);
    options.cache.saveCachedResponse(key, JSON.stringify(response.body), now);
    return parsed.data;
  }

  const list = async (path: string, params: Record<string, string>) =>
    (await get(path, { language: LANGUAGE, ...params }, listResponse, { fresh: false })).results.map(toSummary);

  return {
    async search(query) {
      const response = await get("/search/tv", { query, language: LANGUAGE, include_adult: "false" }, listResponse, {
        fresh: true,
      });
      return response.results.map(toSummary);
    },

    async getSeries(tmdbId, { fresh = false } = {}) {
      const params = { language: LANGUAGE, append_to_response: "translations" };
      return toDetails(await get(`/tv/${tmdbId}`, params, details, { fresh }));
    },

    async getSeasonAirDate(tmdbId, seasonNumber) {
      try {
        const body = await get(`/tv/${tmdbId}/season/${seasonNumber}`, { language: LANGUAGE }, season, {
          fresh: true,
        });
        return toDate(body.air_date);
      } catch (error) {
        if (error instanceof ExternalServiceError && error.kind === "not_found") return null;
        throw error;
      }
    },

    getRecommendations: (tmdbId) => list(`/tv/${tmdbId}/recommendations`, { page: "1" }),

    discover(query: DiscoverQuery) {
      return list("/discover/tv", {
        sort_by: "popularity.desc",
        include_adult: "false",
        include_null_first_air_dates: "false",
        page: "1",
        ...(query.genreIds.length > 0 ? { with_genres: query.genreIds.join("|") } : {}),
        ...(query.firstAirDateTo ? { "first_air_date.lte": query.firstAirDateTo, "vote_count.gte": "50" } : {}),
        ...(query.airDateFrom ? { "air_date.gte": query.airDateFrom } : {}),
        ...(query.airDateTo ? { "air_date.lte": query.airDateTo } : {}),
      });
    },

    async verifyAccess() {
      const body = await get("/authentication", {}, authentication, { fresh: true });
      if (!body.success) throw new ExternalServiceError("tmdb", "auth");
    },
  };
}
