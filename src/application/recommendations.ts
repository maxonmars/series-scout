import { addDays, type IsoDate, localDate } from "../domain/dates.ts";
import { isExcludedFromRecommendations } from "../domain/library.ts";
import type { Profile } from "../domain/profile.ts";
import { type SeriesSummary, upcomingSeason } from "../domain/series.ts";
import { ExternalServiceError, ModelContractError } from "./errors.ts";
import type {
  CandidateSource,
  CatalogPort,
  Clock,
  IdGenerator,
  LibraryStore,
  OutboxStore,
  OutgoingMessage,
  ProfileStore,
  RankingCandidate,
  RecommendationItem,
  RecommendationStore,
  SubscriptionStore,
  TasteModelPort,
  Transactional,
} from "./ports.ts";

export const MAX_RECOMMENDATIONS = 3;
export const MAX_CANDIDATES = 60;
export const UPCOMING_WINDOW_DAYS = 180;
const SIMILAR_SEEDS = 5;
const TOP_GENRES = 3;

export type RecommendationDeps = {
  readonly store: Transactional;
  readonly profiles: ProfileStore;
  readonly library: LibraryStore;
  readonly subscriptions: SubscriptionStore;
  readonly recommendations: RecommendationStore;
  readonly outbox: OutboxStore;
  readonly catalog: CatalogPort;
  readonly model: TasteModelPort;
  readonly clock: Clock;
  readonly newId: IdGenerator;
  readonly timeZone: string;
};

export type RecommendationResult =
  | { readonly status: "no_profile" }
  | { readonly status: "existing" | "created"; readonly count: number };

type Sourced = { readonly series: SeriesSummary; readonly source: CandidateSource };

function topGenres(profile: Profile): number[] {
  const counts = new Map<number, number>();
  for (const title of profile.titles.filter((item) => item.sentiment === "liked")) {
    for (const genre of title.genreIds) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, TOP_GENRES)
    .map(([genre]) => genre);
}

/** По одному кандидату из каждого источника по очереди, чтобы ни один источник не занял все места. */
function interleave(lists: readonly (readonly Sourced[])[]): Sourced[] {
  const result: Sourced[] = [];
  const longest = Math.max(0, ...lists.map((items) => items.length));
  for (let index = 0; index < longest; index++) {
    for (const items of lists) {
      const item = items[index];
      if (item) result.push(item);
    }
  }
  return result;
}

const plural = (count: number) => (count === 1 ? "сериал" : count < 5 ? "сериала" : "сериалов");

export function createRecommendations(deps: RecommendationDeps) {
  const { catalog } = deps;

  function excludedIds(profile: Profile): Set<number> {
    const excluded = deps.recommendations.recommendedIds();
    for (const title of profile.titles) excluded.add(title.tmdbId);
    for (const entry of deps.library.listEntries())
      if (isExcludedFromRecommendations(entry)) excluded.add(entry.tmdbId);
    for (const subscription of deps.subscriptions.listSubscriptions()) {
      if (subscription.active) excluded.add(subscription.tmdbId);
    }
    return excluded;
  }

  async function similarTo(profile: Profile): Promise<Sourced[]> {
    const liked = [
      ...deps.library
        .listEntries()
        .filter((entry) => entry.rating === "liked")
        .map((entry) => entry.tmdbId),
      ...profile.titles.filter((title) => title.sentiment === "liked").map((title) => title.tmdbId),
    ];
    const seeds = [...new Set(liked)].slice(0, SIMILAR_SEEDS);
    const lists: Sourced[][] = [];
    for (const seed of seeds) {
      try {
        lists.push((await catalog.getRecommendations(seed)).map((series) => ({ series, source: "similar" })));
      } catch (error) {
        if (!(error instanceof ExternalServiceError && error.kind === "not_found")) throw error;
      }
    }
    return interleave(lists);
  }

  /** Описание и ближайший сезон берутся из карточки сериала, если в списке их нет. */
  async function toCandidate(item: Sourced, today: IsoDate): Promise<RankingCandidate | null> {
    let { overview } = item.series;
    let upcoming: RankingCandidate["upcoming"] = null;
    if (overview === null || item.source === "upcoming") {
      const details = await catalog.getSeries(item.series.tmdbId);
      overview = details.overview;
      const season = upcomingSeason(details.seasons, today, addDays(today, UPCOMING_WINDOW_DAYS));
      if (season?.airDate) upcoming = { seasonNumber: season.number, date: season.airDate };
      if (item.source === "upcoming" && upcoming === null) return null;
    }
    if (overview === null) return null;
    const { tmdbId, name, originalName, year } = item.series;
    return { tmdbId, name, originalName, year, overview, source: item.source, upcoming };
  }

  async function collectCandidates(profile: Profile, today: IsoDate): Promise<RankingCandidate[]> {
    const genres = topGenres(profile);
    const similar = await similarTo(profile);
    const released = await catalog.discover({ genreIds: genres, firstAirDateTo: today });
    const upcoming = await catalog.discover({
      genreIds: genres,
      airDateFrom: today,
      airDateTo: addDays(today, UPCOMING_WINDOW_DAYS),
    });

    const excluded = excludedIds(profile);
    const candidates: RankingCandidate[] = [];
    for (const item of interleave([
      similar,
      released.map((series) => ({ series, source: "genre" as const })),
      upcoming.map((series) => ({ series, source: "upcoming" as const })),
    ])) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (excluded.has(item.series.tmdbId)) continue;
      excluded.add(item.series.tmdbId);
      const candidate = await toCandidate(item, today);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  function feedback() {
    const entries = deps.library.listEntries();
    const note = (entry: (typeof entries)[number]) => ({ name: entry.name, comment: entry.comment });
    return {
      liked: entries.filter((entry) => entry.rating === "liked").map(note),
      disliked: entries.filter((entry) => entry.rating === "disliked").map(note),
      notInterested: entries.filter((entry) => entry.notInterested).map((entry) => entry.name),
    };
  }

  async function rank(profile: Profile, candidates: readonly RankingCandidate[]): Promise<RecommendationItem[]> {
    if (candidates.length === 0) return [];
    const ranked = await deps.model.rankCandidates({
      profile,
      feedback: feedback(),
      candidates,
      limit: MAX_RECOMMENDATIONS,
    });
    const byId = new Map(candidates.map((candidate) => [candidate.tmdbId, candidate]));
    const seen = new Set<number>();
    return ranked.slice(0, MAX_RECOMMENDATIONS).map(({ tmdbId, explanation }) => {
      const candidate = byId.get(tmdbId);
      if (!candidate) throw new ModelContractError("модель назвала сериал не из переданного списка кандидатов");
      if (seen.has(tmdbId)) throw new ModelContractError("модель повторила сериал в подборке");
      seen.add(tmdbId);
      const { name, originalName, year, overview, upcoming } = candidate;
      return { tmdbId, explanation, card: { tmdbId, name, originalName, year, overview, upcoming, explanation } };
    });
  }

  function messages(items: readonly RecommendationItem[], hadCandidates: boolean): OutgoingMessage[] {
    if (items.length === 0) {
      return [
        {
          kind: "text",
          text: hadCandidates
            ? "Среди новых кандидатов не нашлось подходящих вашему профилю. Попробуйте позже или уточните /profile."
            : "Новых кандидатов не нашлось: всё подходящее уже предлагалось или отмечено. Попробуйте позже или уточните /profile.",
        },
      ];
    }
    return [
      { kind: "text", text: `Подборка: ${items.length} ${plural(items.length)}.` },
      ...items.map((item): OutgoingMessage => ({ kind: "series", card: item.card })),
    ];
  }

  return {
    /** Подборка сохраняется вместе с сообщениями до отправки: повтор доставки не вызывает модель заново. */
    async recommend(triggerKey: string): Promise<RecommendationResult> {
      const existing = deps.recommendations.findBatch(triggerKey);
      if (existing) return { status: "existing", count: existing.items.length };
      const profile = deps.profiles.getProfile();
      if (!profile) return { status: "no_profile" };

      const now = deps.clock.now();
      const candidates = await collectCandidates(profile, localDate(now, deps.timeZone));
      const items = await rank(profile, candidates);
      deps.store.transaction(() => {
        deps.recommendations.saveBatch({ id: deps.newId(), triggerKey, createdAt: now, items });
        deps.outbox.enqueue(`recommendations:${triggerKey}`, messages(items, candidates.length > 0), now);
      });
      return { status: "created", count: items.length };
    },
  };
}

export type Recommendations = ReturnType<typeof createRecommendations>;
