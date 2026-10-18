import { applyFeedback, type Feedback } from "../domain/library.ts";
import type { Sentiment } from "../domain/profile.ts";
import { displayName, seriesUrl } from "../domain/series.ts";
import type { CatalogPort, DialogStore, LibraryStore, OutgoingMessage, SubscriptionStore } from "./ports.ts";

const MAX_SEARCH_RESULTS = 5;

export type LibraryDeps = {
  readonly library: LibraryStore;
  readonly subscriptions: SubscriptionStore;
  readonly dialog: DialogStore;
  readonly catalog: CatalogPort;
};

const text = (value: string): OutgoingMessage => ({ kind: "text", text: value });

export function createLibrary({ library, subscriptions, dialog, catalog }: LibraryDeps) {
  async function seriesRef(tmdbId: number) {
    const known = library.getEntry(tmdbId) ?? subscriptions.getSubscription(tmdbId);
    if (known) return { tmdbId, name: known.name, year: known.year };
    const { name, year } = await catalog.getSeries(tmdbId);
    return { tmdbId, name, year };
  }

  async function apply(tmdbId: number, feedback: Feedback) {
    const series = await seriesRef(tmdbId);
    library.saveEntry(applyFeedback(library.getEntry(tmdbId), series, feedback));
    return series;
  }

  return {
    async search(query: string): Promise<OutgoingMessage[]> {
      dialog.setPendingInput(null);
      const results = (await catalog.search(query)).slice(0, MAX_SEARCH_RESULTS);
      if (results.length === 0) return [text(`По запросу «${query}» ничего не нашлось.`)];
      return [
        text(`Найдено по запросу «${query}»:`),
        ...results.map(
          ({ tmdbId, name, originalName, year, overview }): OutgoingMessage => ({
            kind: "series",
            card: { tmdbId, name, originalName, year, overview, upcoming: null, explanation: null },
          }),
        ),
      ];
    },

    askSearchQuery(): OutgoingMessage[] {
      dialog.setPendingInput({ kind: "search" });
      return [text("Напишите название сериала.")];
    },

    async addToList(tmdbId: number): Promise<OutgoingMessage[]> {
      const series = await apply(tmdbId, { kind: "want_to_watch" });
      return [text(`${displayName(series)} — в списке «Хочу посмотреть». /list — весь список.`)];
    },

    async markWatched(tmdbId: number): Promise<OutgoingMessage[]> {
      const series = await apply(tmdbId, { kind: "watched" });
      return [
        {
          kind: "text",
          text: `${displayName(series)} отмечен как просмотренный. Как вам?`,
          buttons: [
            [
              { text: "Понравилось", action: { type: "rate", tmdbId, rating: "liked" } },
              { text: "Не понравилось", action: { type: "rate", tmdbId, rating: "disliked" } },
            ],
            [{ text: "Без оценки", action: { type: "skip_comment" } }],
          ],
        },
      ];
    },

    async rate(tmdbId: number, rating: Sentiment): Promise<OutgoingMessage[]> {
      const series = await apply(tmdbId, { kind: "rated", rating });
      dialog.setPendingInput({ kind: "comment", tmdbId });
      const verb = rating === "liked" ? "понравился" : "не понравился";
      return [
        {
          kind: "text",
          text: `Оценка сохранена. Если хотите, напишите одним сообщением, чем ${displayName(series)} ${verb} — это учтётся в подборках.`,
          buttons: [[{ text: "Пропустить", action: { type: "skip_comment" } }]],
        },
      ];
    },

    async comment(tmdbId: number, comment: string): Promise<OutgoingMessage[]> {
      await apply(tmdbId, { kind: "commented", comment });
      dialog.setPendingInput(null);
      return [text("Пояснение сохранено.")];
    },

    skipComment(): OutgoingMessage[] {
      dialog.setPendingInput(null);
      return [text("Хорошо. /recommend — новая подборка.")];
    },

    async notInterested(tmdbId: number): Promise<OutgoingMessage[]> {
      const series = await apply(tmdbId, { kind: "not_interested" });
      return [text(`${displayName(series)} больше не будет предлагаться в подборках.`)];
    },

    list(): OutgoingMessage[] {
      const entries = library.listEntries().filter((entry) => entry.wantToWatch);
      if (entries.length === 0) {
        return [text("Список «Хочу посмотреть» пуст. Добавляйте сериалы кнопкой «В список» на карточках.")];
      }
      const lines = entries.map((entry) => `• ${displayName(entry)} — ${seriesUrl(entry.tmdbId)}`);
      return [text(`Хочу посмотреть:\n${lines.join("\n")}`)];
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
