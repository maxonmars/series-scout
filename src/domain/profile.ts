export type Sentiment = "liked" | "disliked";

/** Сериал из профиля; `tmdbId` выбран пользователем по карточке поиска, а не моделью. */
export type ProfileTitle = {
  readonly tmdbId: number;
  readonly name: string;
  readonly year: number | null;
  readonly genreIds: readonly number[];
  readonly sentiment: Sentiment;
  readonly reason: string | null;
};

/** Текстовая часть профиля, которую формирует модель. */
export type TasteDraft = {
  readonly summary: string;
  readonly themes: readonly string[];
  readonly mood: readonly string[];
  readonly pace: string | null;
  readonly avoid: readonly string[];
};

export type Profile = TasteDraft & { readonly titles: readonly ProfileTitle[] };

export const EMPTY_DRAFT: TasteDraft = { summary: "", themes: [], mood: [], pace: null, avoid: [] };

/** Для начала достаточно одного любимого сериала или текстового описания предпочтений. */
export function isProfileUsable(profile: Profile): boolean {
  if (profile.titles.some((title) => title.sentiment === "liked")) return true;
  return profile.summary.trim() !== "" || profile.themes.length > 0 || profile.mood.length > 0;
}

/** Повторное подтверждение того же сериала заменяет прежнюю оценку. */
export function withTitle(titles: readonly ProfileTitle[], title: ProfileTitle): ProfileTitle[] {
  return [...titles.filter((existing) => existing.tmdbId !== title.tmdbId), title];
}
