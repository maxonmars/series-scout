import type { ProfileTitle, Sentiment, TasteDraft } from "./profile.ts";

export const MAX_CLARIFICATIONS = 4;

export type InterviewMessage = { readonly role: "bot" | "user"; readonly text: string };

export type TitleOption = {
  readonly tmdbId: number;
  readonly name: string;
  readonly year: number | null;
  readonly genreIds: readonly number[];
};

/** Название из ответа пользователя, которое ждёт выбора карточки каталога. */
export type PendingTitle = {
  readonly query: string;
  readonly sentiment: Sentiment;
  readonly reason: string | null;
  readonly options: readonly TitleOption[];
};

/**
 * Незавершённое интервью. `asking` — ждём ответа на вопрос, `resolving` — выбора карточки
 * для `pending[0]`, `confirming` — подтверждения итога.
 */
export type InterviewState = {
  readonly mode: "new" | "edit";
  readonly step: "asking" | "resolving" | "confirming";
  readonly conversation: readonly InterviewMessage[];
  readonly clarifications: number;
  readonly draft: TasteDraft;
  readonly titles: readonly ProfileTitle[];
  readonly pending: readonly PendingTitle[];
  readonly nextQuestion: string | null;
};
