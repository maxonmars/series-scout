import type {
  CalendarEvent,
  CalendarPort,
  CatalogPort,
  DiscoverQuery,
  InterviewStepInput,
  InterviewStepResult,
  OutgoingMessage,
  RankedItem,
  RankingInput,
  TasteModelPort,
} from "../../src/application/ports.ts";
import { EMPTY_DRAFT } from "../../src/domain/profile.ts";
import type { Season, SeriesDetails, SeriesSummary } from "../../src/domain/series.ts";

export function series(tmdbId: number, name: string, overrides: Partial<SeriesDetails> = {}): SeriesDetails {
  const firstAirDate = overrides.firstAirDate === undefined ? "2020-01-01" : overrides.firstAirDate;
  return {
    tmdbId,
    name,
    originalName: name,
    firstAirDate,
    year: firstAirDate === null ? null : Number(firstAirDate.slice(0, 4)),
    overview: `Описание: ${name}`,
    genreIds: [18],
    seasons: [{ number: 1, airDate: firstAirDate }],
    ...overrides,
  };
}

export type FakeCatalog = CatalogPort & {
  readonly calls: { method: string; args: unknown[] }[];
  readonly seriesById: Map<number, SeriesDetails>;
  searchResults: Record<string, SeriesSummary[]>;
  recommendations: Record<number, SeriesSummary[]>;
  discoverResults: (query: DiscoverQuery) => SeriesSummary[];
  /** Даты, которые отдаёт эндпоинт сезона; по умолчанию — из карточки сериала. */
  seasonDates: Map<string, string | null>;
  failFor: Set<number>;
  onGetSeries: (tmdbId: number) => Promise<void> | void;
};

export function fakeCatalog(all: readonly SeriesDetails[] = []): FakeCatalog {
  const catalog: FakeCatalog = {
    calls: [],
    seriesById: new Map(all.map((item) => [item.tmdbId, item])),
    searchResults: {},
    recommendations: {},
    discoverResults: () => [],
    seasonDates: new Map(),
    failFor: new Set(),
    onGetSeries: () => {},
    async search(query) {
      catalog.calls.push({ method: "search", args: [query] });
      return catalog.searchResults[query] ?? [];
    },
    async getSeries(tmdbId, options) {
      catalog.calls.push({ method: "getSeries", args: [tmdbId, options] });
      await catalog.onGetSeries(tmdbId);
      if (catalog.failFor.has(tmdbId)) throw new Error(`каталог недоступен для ${tmdbId}`);
      const found = catalog.seriesById.get(tmdbId);
      if (!found) throw new Error(`нет сериала ${tmdbId} в подменённом каталоге`);
      return found;
    },
    async getSeasonAirDate(tmdbId, seasonNumber) {
      catalog.calls.push({ method: "getSeasonAirDate", args: [tmdbId, seasonNumber] });
      const key = `${tmdbId}:${seasonNumber}`;
      if (catalog.seasonDates.has(key)) return catalog.seasonDates.get(key) ?? null;
      return catalog.seriesById.get(tmdbId)?.seasons.find((season) => season.number === seasonNumber)?.airDate ?? null;
    },
    async getRecommendations(tmdbId) {
      catalog.calls.push({ method: "getRecommendations", args: [tmdbId] });
      return catalog.recommendations[tmdbId] ?? [];
    },
    async discover(query) {
      catalog.calls.push({ method: "discover", args: [query] });
      return catalog.discoverResults(query);
    },
  };
  return catalog;
}

export function setSeasons(catalog: FakeCatalog, tmdbId: number, seasons: Season[]): void {
  const current = catalog.seriesById.get(tmdbId);
  if (!current) throw new Error(`нет сериала ${tmdbId} в подменённом каталоге`);
  catalog.seriesById.set(tmdbId, { ...current, seasons });
}

export type ScriptedModel = TasteModelPort & {
  readonly interviewInputs: InterviewStepInput[];
  readonly rankingInputs: RankingInput[];
  interview: (input: InterviewStepInput) => Partial<InterviewStepResult>;
  ranking: (input: RankingInput) => RankedItem[] | Promise<RankedItem[]>;
};

export function scriptedModel(): ScriptedModel {
  const model: ScriptedModel = {
    interviewInputs: [],
    rankingInputs: [],
    interview: () => ({}),
    ranking: (input) =>
      input.candidates.slice(0, input.limit).map((candidate) => ({
        tmdbId: candidate.tmdbId,
        explanation: `Подходит: ${candidate.name}`,
      })),
    async interviewStep(input) {
      model.interviewInputs.push(input);
      return { draft: input.draft, mentionedTitles: [], removedTitles: [], question: null, ...model.interview(input) };
    },
    async rankCandidates(input) {
      model.rankingInputs.push(input);
      return model.ranking(input);
    },
  };
  return model;
}

export const draftWith = (summary: string) => ({ ...EMPTY_DRAFT, summary });

export type FakeCalendar = CalendarPort & {
  readonly events: Map<string, CalendarEvent & { status: "confirmed" | "cancelled" }>;
  readonly calls: string[];
  fail: Error | null;
  /** Сбой после того, как Google применил операцию: ответ до приложения не дошёл. */
  failAfterApply: Error | null;
};

export function fakeCalendar(): FakeCalendar {
  const calendar: FakeCalendar = {
    events: new Map(),
    calls: [],
    fail: null,
    failAfterApply: null,
    async createEvent(event) {
      calendar.calls.push(`create ${event.eventId}`);
      if (calendar.fail) throw calendar.fail;
      calendar.events.set(event.eventId, { ...event, status: "confirmed" });
      if (calendar.failAfterApply) throw calendar.failAfterApply;
    },
    async updateEvent(event) {
      calendar.calls.push(`update ${event.eventId}`);
      if (calendar.fail) throw calendar.fail;
      if (!calendar.events.has(event.eventId)) return "missing";
      calendar.events.set(event.eventId, { ...event, status: "confirmed" });
      return "updated";
    },
    async deleteEvent(eventId) {
      calendar.calls.push(`delete ${eventId}`);
      if (calendar.fail) throw calendar.fail;
      const existing = calendar.events.get(eventId);
      if (existing) calendar.events.set(eventId, { ...existing, status: "cancelled" });
    },
  };
  return calendar;
}

export const activeEvents = (calendar: FakeCalendar) =>
  [...calendar.events.values()].filter((event) => event.status === "confirmed");

export function textOf(messages: readonly OutgoingMessage[]): string {
  return messages.map((message) => (message.kind === "text" ? message.text : `[card ${message.card.name}]`)).join("\n");
}

export function buttonsOf(messages: readonly OutgoingMessage[]): string[] {
  return messages.flatMap((message) =>
    message.kind === "text" ? (message.buttons ?? []).flat().map((button) => button.text) : [],
  );
}
