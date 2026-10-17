import type { CalendarEventRecord } from "../domain/calendar.ts";
import type { IsoDate } from "../domain/dates.ts";
import type { InterviewMessage, InterviewState } from "../domain/interview.ts";
import type { LibraryEntry } from "../domain/library.ts";
import type { KnownPremiere, Subscription } from "../domain/premieres.ts";
import type { Profile, Sentiment, TasteDraft } from "../domain/profile.ts";
import type { SeriesDetails, SeriesSummary } from "../domain/series.ts";
import type { ServiceName } from "./errors.ts";

export type Clock = { readonly now: () => number };
export type IdGenerator = () => string;
export type Logger = { readonly info: (message: string) => void; readonly error: (message: string) => void };

// --- Внешние сервисы ---

export type DiscoverQuery = {
  readonly genreIds: readonly number[];
  readonly firstAirDateTo?: IsoDate;
  readonly airDateFrom?: IsoDate;
  readonly airDateTo?: IsoDate;
};

/** Каталог сериалов. `fresh` обходит кэш: так проверяются премьеры. */
export type CatalogPort = {
  readonly search: (query: string) => Promise<SeriesSummary[]>;
  readonly getSeries: (tmdbId: number, options?: { readonly fresh?: boolean }) => Promise<SeriesDetails>;
  /** Дата начала сезона всегда запрашивается у источника без кэша. */
  readonly getSeasonAirDate: (tmdbId: number, seasonNumber: number) => Promise<IsoDate | null>;
  readonly getRecommendations: (tmdbId: number) => Promise<SeriesSummary[]>;
  readonly discover: (query: DiscoverQuery) => Promise<SeriesSummary[]>;
};

export type MentionedTitle = { readonly query: string; readonly sentiment: Sentiment; readonly reason: string | null };

export type InterviewStepInput = {
  readonly mode: "new" | "edit";
  readonly conversation: readonly InterviewMessage[];
  readonly clarificationsLeft: number;
  readonly draft: TasteDraft;
  readonly titles: readonly {
    readonly name: string;
    readonly year: number | null;
    readonly sentiment: Sentiment;
    readonly reason: string | null;
  }[];
};

export type InterviewStepResult = {
  readonly draft: TasteDraft;
  /** Названия из последнего ответа пользователя; каталожные ID назначает не модель. */
  readonly mentionedTitles: readonly MentionedTitle[];
  /** Имена подтверждённых сериалов, которые пользователь попросил убрать. */
  readonly removedTitles: readonly string[];
  readonly question: string | null;
};

export type CandidateSource = "similar" | "genre" | "upcoming";

export type RankingCandidate = {
  readonly tmdbId: number;
  readonly name: string;
  readonly originalName: string;
  readonly year: number | null;
  readonly overview: string;
  readonly source: CandidateSource;
  readonly upcoming: { readonly seasonNumber: number; readonly date: IsoDate } | null;
};

export type FeedbackNote = { readonly name: string; readonly comment: string | null };

export type RankingInput = {
  readonly profile: Profile;
  readonly feedback: {
    readonly liked: readonly FeedbackNote[];
    readonly disliked: readonly FeedbackNote[];
    readonly notInterested: readonly string[];
  };
  readonly candidates: readonly RankingCandidate[];
  readonly limit: number;
};

export type RankedItem = { readonly tmdbId: number; readonly explanation: string };

export type TasteModelPort = {
  readonly interviewStep: (input: InterviewStepInput) => Promise<InterviewStepResult>;
  readonly rankCandidates: (input: RankingInput) => Promise<RankedItem[]>;
};

export type CalendarEvent = {
  readonly eventId: string;
  readonly premiereKey: string;
  readonly date: IsoDate;
  readonly summary: string;
  readonly description: string;
};

/** Управляемые события отдельного календаря. Методы идемпотентны по `eventId`. */
export type CalendarPort = {
  /** Конфликт ID разрешается чтением существующего события и его обновлением. */
  readonly createEvent: (event: CalendarEvent) => Promise<void>;
  readonly updateEvent: (event: CalendarEvent) => Promise<"updated" | "missing">;
  /** Отсутствующее событие считается удалённым. */
  readonly deleteEvent: (eventId: string) => Promise<void>;
};

export type ButtonAction =
  | { readonly type: "want" | "watched" | "not_interested" | "follow" | "unfollow"; readonly tmdbId: number }
  | { readonly type: "rate"; readonly tmdbId: number; readonly rating: Sentiment }
  | { readonly type: "pick_title"; readonly tmdbId: number }
  | {
      readonly type:
        | "skip_comment"
        | "skip_title"
        | "finish_interview"
        | "confirm_profile"
        | "cancel_profile"
        | "edit_profile";
    };

export type Button = { readonly text: string; readonly action: ButtonAction };

export type SeriesCard = {
  readonly tmdbId: number;
  readonly name: string;
  readonly originalName: string;
  readonly year: number | null;
  readonly overview: string | null;
  readonly upcoming: { readonly seasonNumber: number; readonly date: IsoDate } | null;
  readonly explanation: string | null;
};

/** Сообщение владельцу. Карточка сериала всегда показывается со стандартными кнопками действий. */
export type OutgoingMessage =
  | { readonly kind: "text"; readonly text: string; readonly buttons?: readonly (readonly Button[])[] }
  | { readonly kind: "series"; readonly card: SeriesCard };

export type NotificationPort = { readonly send: (message: OutgoingMessage) => Promise<void> };

// --- Хранилище: синхронные операции, транзакции короткие и без сетевых вызовов ---

export type Transactional = { readonly transaction: <T>(work: () => T) => T };

export type ProfileStore = {
  readonly getProfile: () => Profile | null;
  readonly getInterview: () => InterviewState | null;
  readonly saveInterview: (state: InterviewState) => void;
  readonly deleteInterview: () => void;
  /** Сохраняет профиль и завершает интервью одной транзакцией. */
  readonly confirmProfile: (profile: Profile) => void;
};

export type PendingInput = { readonly kind: "search" } | { readonly kind: "comment"; readonly tmdbId: number };

export type DialogStore = {
  readonly getPendingInput: () => PendingInput | null;
  readonly setPendingInput: (input: PendingInput | null) => void;
};

export type LibraryStore = {
  readonly getEntry: (tmdbId: number) => LibraryEntry | null;
  readonly saveEntry: (entry: LibraryEntry) => void;
  readonly listEntries: () => LibraryEntry[];
};

export type SubscriptionStore = {
  readonly getSubscription: (tmdbId: number) => Subscription | null;
  readonly saveSubscription: (subscription: Subscription) => void;
  readonly listSubscriptions: () => Subscription[];
  readonly getPremieres: (tmdbId: number) => KnownPremiere[];
  readonly savePremieres: (tmdbId: number, premieres: readonly KnownPremiere[]) => void;
};

export type CalendarStore = {
  readonly getCalendarEvent: (tmdbId: number, seasonNumber: number) => CalendarEventRecord | null;
  readonly saveCalendarEvent: (record: CalendarEventRecord) => void;
  readonly listCalendarEvents: () => CalendarEventRecord[];
};

export type RecommendationItem = { readonly tmdbId: number; readonly explanation: string; readonly card: SeriesCard };

export type RecommendationBatch = {
  readonly id: string;
  /** Ключ логического запуска: повторный запуск с тем же ключом не создаёт новую подборку. */
  readonly triggerKey: string;
  readonly createdAt: number;
  readonly items: readonly RecommendationItem[];
};

export type RecommendationStore = {
  readonly findBatch: (triggerKey: string) => RecommendationBatch | null;
  readonly saveBatch: (batch: RecommendationBatch) => void;
  readonly recommendedIds: () => Set<number>;
};

export type OutboxItem = { readonly id: string; readonly message: OutgoingMessage; readonly attempts: number };

export type OutboxStore = {
  /** Повтор с тем же `dedupeKey` игнорируется. */
  readonly enqueue: (dedupeKey: string, messages: readonly OutgoingMessage[], now: number) => void;
  /** Неотправленные сообщения по порядку — до первого, чей повтор ещё не наступил. */
  readonly dueMessages: (now: number) => OutboxItem[];
  readonly markSent: (id: string, now: number) => void;
  readonly markFailed: (id: string, error: string, nextAttemptAt: number) => void;
  readonly countPending: () => number;
};

export type JobRecord = {
  readonly name: string;
  /** Описание расписания, по которому рассчитан `nextRunAt`; при смене настройки срок пересчитывается. */
  readonly schedule: string;
  readonly nextRunAt: number;
  readonly lastStartedAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
};

export type JobStore = {
  readonly getJob: (name: string) => JobRecord | null;
  readonly saveJob: (job: JobRecord) => void;
};

export type ServiceHealth = {
  readonly service: ServiceName;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
};

/** Результаты обращений к внешним сервисам для `/status`; записывают адаптеры. */
export type HealthStore = {
  readonly recordHealth: (service: ServiceName, at: number, error: string | null) => void;
  readonly listHealth: () => ServiceHealth[];
};
