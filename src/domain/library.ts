import type { Sentiment } from "./profile.ts";

/** Отношение пользователя к сериалу. Подписка на сезоны хранится отдельно и от этих флагов не зависит. */
export type LibraryEntry = {
  readonly tmdbId: number;
  readonly name: string;
  readonly year: number | null;
  readonly wantToWatch: boolean;
  readonly watched: boolean;
  readonly rating: Sentiment | null;
  readonly comment: string | null;
  readonly notInterested: boolean;
};

export type Feedback =
  | { readonly kind: "want_to_watch" }
  | { readonly kind: "watched" }
  | { readonly kind: "rated"; readonly rating: Sentiment }
  | { readonly kind: "commented"; readonly comment: string }
  | { readonly kind: "not_interested" };

type SeriesRef = { readonly tmdbId: number; readonly name: string; readonly year: number | null };

/** Просмотр и «Не интересно» убирают сериал из списка «Хочу посмотреть»; оценка подразумевает просмотр. */
export function applyFeedback(entry: LibraryEntry | null, series: SeriesRef, feedback: Feedback): LibraryEntry {
  const base: LibraryEntry = entry ?? {
    ...series,
    wantToWatch: false,
    watched: false,
    rating: null,
    comment: null,
    notInterested: false,
  };
  switch (feedback.kind) {
    case "want_to_watch":
      return { ...base, wantToWatch: true, notInterested: false };
    case "watched":
      return { ...base, watched: true, wantToWatch: false };
    case "rated":
      return { ...base, watched: true, wantToWatch: false, rating: feedback.rating };
    case "commented":
      return { ...base, comment: feedback.comment };
    case "not_interested":
      return { ...base, notInterested: true, wantToWatch: false };
  }
}

/** Сериал больше не предлагается в подборках. */
export function isExcludedFromRecommendations(entry: LibraryEntry): boolean {
  return entry.watched || entry.wantToWatch || entry.notInterested || entry.rating !== null;
}
