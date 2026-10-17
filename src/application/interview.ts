import { type InterviewState, MAX_CLARIFICATIONS, type PendingTitle, type TitleOption } from "../domain/interview.ts";
import { EMPTY_DRAFT, isProfileUsable, type Profile, withTitle } from "../domain/profile.ts";
import { displayName } from "../domain/series.ts";
import type { Button, CatalogPort, OutgoingMessage, ProfileStore, TasteModelPort } from "./ports.ts";

const OPENING_QUESTION =
  "Расскажите, какие сериалы вам понравились или не понравились и чем. " +
  "Можно просто описать, что хочется посмотреть: темы, атмосферу, темп.";

const EDIT_QUESTION = "Что изменить? Напишите, что добавить или убрать: сериалы, темы, атмосферу, темп.";

const MAX_OPTIONS = 3;

export type InterviewDeps = {
  readonly profiles: ProfileStore;
  readonly catalog: CatalogPort;
  readonly model: TasteModelPort;
};

const text = (value: string, buttons?: readonly (readonly Button[])[]): OutgoingMessage =>
  buttons === undefined ? { kind: "text", text: value } : { kind: "text", text: value, buttons };

const list = (values: readonly string[]) => values.join(", ");

export function renderProfile(profile: Profile): string {
  const lines: string[] = [];
  if (profile.summary.trim() !== "") lines.push(`Кратко: ${profile.summary}`);
  for (const [sentiment, title] of [
    ["liked", "Нравится"],
    ["disliked", "Не нравится"],
  ] as const) {
    const titles = profile.titles.filter((item) => item.sentiment === sentiment);
    if (titles.length === 0) continue;
    lines.push(`${title}:`);
    for (const item of titles) lines.push(`  • ${displayName(item)}${item.reason ? ` — ${item.reason}` : ""}`);
  }
  if (profile.themes.length > 0) lines.push(`Темы: ${list(profile.themes)}`);
  if (profile.mood.length > 0) lines.push(`Атмосфера: ${list(profile.mood)}`);
  if (profile.pace) lines.push(`Темп: ${profile.pace}`);
  if (profile.avoid.length > 0) lines.push(`Не подходит: ${list(profile.avoid)}`);
  return lines.length > 0 ? lines.join("\n") : "Пока пусто.";
}

const draftProfile = (state: InterviewState): Profile => ({ ...state.draft, titles: state.titles });

function questionMessage(question: string): OutgoingMessage {
  return text(question, [[{ text: "Готово, показать итог", action: { type: "finish_interview" } }]]);
}

function pendingMessage(pending: PendingTitle): OutgoingMessage {
  const skip = { text: "Пропустить", action: { type: "skip_title" } } as const;
  if (pending.options.length === 0) {
    return text(`Не нашёл «${pending.query}» в каталоге. Напишите название иначе или пропустите.`, [[skip]]);
  }
  return text(`Какой сериал вы имели в виду под «${pending.query}»? Если нужного нет — напишите название точнее.`, [
    ...pending.options.map((option) => [
      { text: displayName(option), action: { type: "pick_title", tmdbId: option.tmdbId } } as const,
    ]),
    [skip],
  ]);
}

function summaryMessage(state: InterviewState): OutgoingMessage {
  const profile = draftProfile(state);
  const cancel = { text: "Отменить изменения", action: { type: "cancel_profile" } } as const;
  const extra = state.mode === "edit" ? [[cancel]] : [];
  if (!isProfileUsable(profile)) {
    return text(
      "Пока недостаточно сведений для профиля: назовите хотя бы один понравившийся сериал или опишите, что хочется посмотреть.",
      extra.length > 0 ? extra : undefined,
    );
  }
  return text(`Итог профиля:\n\n${renderProfile(profile)}\n\nСохранить? Можно дописать уточнение сообщением.`, [
    [{ text: "Сохранить профиль", action: { type: "confirm_profile" } }],
    ...extra,
  ]);
}

const STALE = text("Этот вопрос уже неактуален. /start — продолжить интервью.");

export function createInterview({ profiles, catalog, model }: InterviewDeps) {
  async function findOptions(query: string): Promise<TitleOption[]> {
    const results = await catalog.search(query);
    return results.slice(0, MAX_OPTIONS).map(({ tmdbId, name, year, genreIds }) => ({ tmdbId, name, year, genreIds }));
  }

  /** Сначала разрешаются названия, затем задаётся следующий вопрос, иначе показывается итог. */
  function advance(state: InterviewState): OutgoingMessage[] {
    const [pending] = state.pending;
    if (pending) {
      profiles.saveInterview({ ...state, step: "resolving" });
      return [pendingMessage(pending)];
    }
    if (state.nextQuestion !== null) {
      const question = state.nextQuestion;
      profiles.saveInterview({
        ...state,
        step: "asking",
        conversation: [...state.conversation, { role: "bot", text: question }],
        clarifications: state.clarifications + 1,
        nextQuestion: null,
      });
      return [questionMessage(question)];
    }
    const confirming: InterviewState = { ...state, step: "confirming" };
    profiles.saveInterview(confirming);
    return [summaryMessage(confirming)];
  }

  function resume(state: InterviewState): OutgoingMessage[] {
    if (state.step === "resolving" && state.pending[0]) return [pendingMessage(state.pending[0])];
    if (state.step === "confirming") return [summaryMessage(state)];
    const lastQuestion = state.conversation.findLast((message) => message.role === "bot")?.text ?? OPENING_QUESTION;
    return [questionMessage(lastQuestion)];
  }

  async function answer(state: InterviewState, reply: string): Promise<OutgoingMessage[]> {
    const conversation = [...state.conversation, { role: "user" as const, text: reply }];
    const result = await model.interviewStep({
      mode: state.mode,
      conversation,
      clarificationsLeft: Math.max(0, MAX_CLARIFICATIONS - state.clarifications),
      draft: state.draft,
      titles: state.titles.map(({ name, year, sentiment, reason }) => ({ name, year, sentiment, reason })),
    });
    const pending: PendingTitle[] = [];
    for (const mention of result.mentionedTitles) {
      pending.push({ ...mention, options: await findOptions(mention.query) });
    }
    return advance({
      ...state,
      conversation,
      draft: result.draft,
      titles: state.titles.filter((title) => !result.removedTitles.includes(title.name)),
      pending: [...state.pending, ...pending],
      nextQuestion: state.clarifications < MAX_CLARIFICATIONS ? result.question : null,
    });
  }

  function begin(mode: InterviewState["mode"], profile: Profile | null): OutgoingMessage[] {
    const question = mode === "edit" ? EDIT_QUESTION : OPENING_QUESTION;
    const { summary, themes, mood, pace, avoid } = profile ?? EMPTY_DRAFT;
    profiles.saveInterview({
      mode,
      step: "asking",
      conversation: [{ role: "bot", text: question }],
      clarifications: 0,
      draft: { summary, themes, mood, pace, avoid },
      titles: profile?.titles ?? [],
      pending: [],
      nextQuestion: null,
    });
    if (mode === "edit" && profile)
      return [text(`Текущий профиль:\n\n${renderProfile(profile)}`), questionMessage(question)];
    return [
      text("Я Series Scout: помогаю выбирать сериалы и слежу за премьерами новых сезонов."),
      questionMessage(question),
    ];
  }

  return {
    isActive: () => profiles.getInterview() !== null,

    start(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (state) return resume(state);
      if (profiles.getProfile()) {
        return [
          text("С возвращением! /recommend — новая подборка, /profile — изменить предпочтения, /help — все команды."),
        ];
      }
      return begin("new", null);
    },

    showProfile(): OutgoingMessage[] {
      const profile = profiles.getProfile();
      const editing = profiles.getInterview() !== null;
      if (!profile) {
        return [text(`Профиль ещё не заполнен. /start — ${editing ? "продолжить" : "начать"} интервью.`)];
      }
      const note = editing ? "\n\nИдёт изменение профиля: /start — продолжить." : "";
      return [
        text(`Ваш профиль:\n\n${renderProfile(profile)}${note}`, [
          [{ text: "Изменить профиль", action: { type: "edit_profile" } }],
        ]),
      ];
    },

    edit(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (state) return resume(state);
      const profile = profiles.getProfile();
      return profile ? begin("edit", profile) : begin("new", null);
    },

    async handleText(reply: string): Promise<OutgoingMessage[]> {
      const state = profiles.getInterview();
      if (!state) return [];
      const [pending, ...rest] = state.pending;
      if (state.step === "resolving" && pending) {
        const corrected: PendingTitle = { ...pending, query: reply, options: await findOptions(reply) };
        return advance({ ...state, pending: [corrected, ...rest] });
      }
      return answer(state, reply);
    },

    pickTitle(tmdbId: number): OutgoingMessage[] {
      const state = profiles.getInterview();
      const [pending, ...rest] = state?.pending ?? [];
      const option = pending?.options.find((item) => item.tmdbId === tmdbId);
      if (state?.step !== "resolving" || !pending || !option) return [STALE];
      const title = { ...option, sentiment: pending.sentiment, reason: pending.reason };
      return advance({ ...state, titles: withTitle(state.titles, title), pending: rest });
    },

    skipTitle(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (state?.step !== "resolving") return [STALE];
      return advance({ ...state, pending: state.pending.slice(1) });
    },

    finish(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (!state) return [STALE];
      if (state.step === "resolving") return resume(state);
      return advance({ ...state, nextQuestion: null });
    },

    confirm(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (state?.step !== "confirming") return [STALE];
      const profile = draftProfile(state);
      if (!isProfileUsable(profile)) return [summaryMessage(state)];
      profiles.confirmProfile(profile);
      return [text("Профиль сохранён. /recommend — подобрать сериалы.")];
    },

    cancel(): OutgoingMessage[] {
      const state = profiles.getInterview();
      if (!state) return [STALE];
      profiles.deleteInterview();
      return [
        text(
          state.mode === "edit" && profiles.getProfile()
            ? "Изменения отменены, действует прежний профиль."
            : "Интервью сброшено. /start — начать заново.",
        ),
      ];
    },
  };
}

export type Interview = ReturnType<typeof createInterview>;
