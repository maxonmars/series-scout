import { describe, expect, it } from "vitest";
import { createTmdbCatalog, type ResponseCache } from "../src/adapters/tmdb/catalog.ts";
import { ExternalServiceError } from "../src/application/errors.ts";

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function memoryCache(): ResponseCache & { entries: Map<string, { body: string; at: number }> } {
  const entries = new Map<string, { body: string; at: number }>();
  return {
    entries,
    getCachedResponse: (key, notOlderThan) => {
      const entry = entries.get(key);
      return entry && entry.at >= notOlderThan ? entry.body : null;
    },
    saveCachedResponse: (key, body, at) => entries.set(key, { body, at }),
  };
}

function setup(route: Route, options: { now?: () => number; timeoutMs?: number } = {}) {
  const requests: URL[] = [];
  const sleeps: number[] = [];
  const cache = memoryCache();
  const catalog = createTmdbCatalog({
    readAccessToken: "test-token",
    cache,
    now: options.now ?? (() => 1_000_000),
    timeoutMs: options.timeoutMs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      return route(url, init ?? {});
    },
  });
  return { catalog, requests, sleeps, cache };
}

describe("TMDB: поиск", () => {
  it("различает сериалы с одинаковым названием по году и ID", async () => {
    const { catalog, requests } = setup(() =>
      json({
        results: [
          { id: 1, name: "Офис", original_name: "The Office", first_air_date: "2001-07-09", overview: "Британский" },
          { id: 2, name: "Офис", original_name: "The Office", first_air_date: "2005-03-24", overview: "Американский" },
        ],
      }),
    );
    const results = await catalog.search("Офис");
    expect(results.map((series) => [series.tmdbId, series.year])).toEqual([
      [1, 2001],
      [2, 2005],
    ]);
    expect(requests[0]?.searchParams.get("language")).toBe("ru-RU");
    expect(requests[0]?.searchParams.get("query")).toBe("Офис");
  });

  it("берёт переведённое название, а без перевода — оригинальное", async () => {
    const { catalog } = setup(() =>
      json({
        results: [
          { id: 1, name: "Тьма", original_name: "Dark", first_air_date: "2017-12-01" },
          { id: 2, name: "", original_name: "Kingdom", first_air_date: "" },
        ],
      }),
    );
    const [dark, kingdom] = await catalog.search("dark");
    expect(dark).toMatchObject({ name: "Тьма", originalName: "Dark" });
    expect(kingdom).toMatchObject({ name: "Kingdom", firstAirDate: null, year: null, overview: null });
  });
});

describe("TMDB: сериал и сезоны", () => {
  const detailsBody = {
    id: 10,
    name: "Разделение",
    original_name: "Severance",
    first_air_date: "2022-02-17",
    overview: "",
    genres: [{ id: 18, name: "драма" }],
    seasons: [
      { season_number: 0, air_date: "2021-01-01" },
      { season_number: 2, air_date: "2025-01-17" },
      { season_number: 1, air_date: "2022-02-17" },
      { season_number: 3, air_date: "" },
    ],
    translations: { translations: [{ iso_639_1: "en", data: { overview: "Office workers", name: "Severance" } }] },
  };

  it("исключает сезон 0, сохраняет неизвестные даты и подставляет английское описание", async () => {
    const { catalog } = setup(() => json(detailsBody));
    const series = await catalog.getSeries(10);
    expect(series.seasons).toEqual([
      { number: 1, airDate: "2022-02-17" },
      { number: 2, airDate: "2025-01-17" },
      { number: 3, airDate: null },
    ]);
    expect(series.overview).toBe("Office workers");
    expect(series.genreIds).toEqual([18]);
  });

  it("сериал без описания на обоих языках остаётся доступным с overview = null", async () => {
    const { catalog } = setup(() => json({ ...detailsBody, translations: { translations: [] } }));
    expect((await catalog.getSeries(10)).overview).toBeNull();
  });

  it("кэширует сведения для рекомендаций на сутки, а fresh обращается к источнику", async () => {
    let now = 1_000_000;
    const { catalog, requests } = setup(() => json(detailsBody), { now: () => now });
    await catalog.getSeries(10);
    await catalog.getSeries(10);
    expect(requests).toHaveLength(1);
    await catalog.getSeries(10, { fresh: true });
    expect(requests).toHaveLength(2);
    now += 24 * 60 * 60 * 1000 + 1;
    await catalog.getSeries(10);
    expect(requests).toHaveLength(3);
  });

  it("дата сезона: пустая — неизвестна, отсутствующий сезон — тоже", async () => {
    const { catalog } = setup((url) =>
      url.pathname.endsWith("/season/3") ? json({ air_date: "" }) : new Response("{}", { status: 404 }),
    );
    expect(await catalog.getSeasonAirDate(10, 3)).toBeNull();
    expect(await catalog.getSeasonAirDate(10, 4)).toBeNull();
  });
});

describe("TMDB: ошибки", () => {
  it("повторяет 429 с учётом Retry-After", async () => {
    let calls = 0;
    const { catalog, sleeps } = setup(() =>
      ++calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : json({ air_date: "2027-03-01" }),
    );
    expect(await catalog.getSeasonAirDate(10, 2)).toBe("2027-03-01");
    expect(sleeps).toEqual([2000]);
  });

  it("после исчерпания попыток сообщает о лимите запросов", async () => {
    const { catalog, requests } = setup(() => new Response("", { status: 429 }));
    await expect(catalog.search("x")).rejects.toMatchObject({ service: "tmdb", kind: "rate_limit" });
    expect(requests).toHaveLength(3);
  });

  it("ошибку авторизации не повторяет", async () => {
    const { catalog, requests } = setup(() => new Response("", { status: 401 }));
    await expect(catalog.search("x")).rejects.toMatchObject({ kind: "auth" });
    expect(requests).toHaveLength(1);
  });

  it("тайм-аут превращается в ошибку timeout", async () => {
    const { catalog } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 5 },
    );
    await expect(catalog.search("x")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("ответ не по контракту — invalid_response, без попадания в кэш", async () => {
    const { catalog, cache } = setup(() => json({ results: [{ id: "не число" }] }));
    const error = await catalog.getRecommendations(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(cache.entries.size).toBe(0);
  });

  it("токен передаётся только в заголовке, не в адресе", async () => {
    let authorization: string | null = null;
    const { catalog, requests } = setup((_url, init) => {
      authorization = new Headers(init.headers).get("authorization");
      return json({ results: [] });
    });
    await catalog.discover({ genreIds: [18, 80], airDateFrom: "2026-10-17", airDateTo: "2027-04-15" });
    expect(authorization).toBe("Bearer test-token");
    expect(String(requests[0])).not.toContain("test-token");
    expect(requests[0]?.searchParams.get("with_genres")).toBe("18|80");
    expect(requests[0]?.searchParams.get("air_date.lte")).toBe("2027-04-15");
  });
});
