import { InlineKeyboard } from "grammy";
import { formatDate } from "../../application/format.ts";
import type { Button, ButtonAction, OutgoingMessage, SeriesCard } from "../../application/ports.ts";
import { seriesUrl } from "../../domain/series.ts";

const MAX_TEXT = 4096;
const MAX_OVERVIEW = 700;

const SIMPLE_ACTIONS = {
  sc: "skip_comment",
  st: "skip_title",
  fi: "finish_interview",
  cp: "confirm_profile",
  cx: "cancel_profile",
  ep: "edit_profile",
} as const;

const SERIES_ACTIONS = {
  w: "want",
  s: "watched",
  n: "not_interested",
  f: "follow",
  u: "unfollow",
  p: "pick_title",
} as const;

type SimpleCode = keyof typeof SIMPLE_ACTIONS;
type SeriesCode = keyof typeof SERIES_ACTIONS;

const isSimpleCode = (code: string): code is SimpleCode => code in SIMPLE_ACTIONS;
const isSeriesCode = (code: string): code is SeriesCode => code in SERIES_ACTIONS;

/** Компактная запись действия: callback_data в Telegram ограничена 64 байтами. */
export function encodeAction(action: ButtonAction): string {
  if (action.type === "rate") return `r:${action.tmdbId}:${action.rating === "liked" ? "l" : "d"}`;
  if ("tmdbId" in action) {
    const code = (Object.keys(SERIES_ACTIONS) as SeriesCode[]).find((key) => SERIES_ACTIONS[key] === action.type);
    return `${code}:${action.tmdbId}`;
  }
  const code = (Object.keys(SIMPLE_ACTIONS) as SimpleCode[]).find((key) => SIMPLE_ACTIONS[key] === action.type);
  return `${code}`;
}

export function decodeAction(data: string): ButtonAction | null {
  const [code = "", id, extra] = data.split(":");
  if (isSimpleCode(code) && id === undefined) return { type: SIMPLE_ACTIONS[code] };
  const tmdbId = Number(id);
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;
  if (code === "r" && (extra === "l" || extra === "d")) {
    return { type: "rate", tmdbId, rating: extra === "l" ? "liked" : "disliked" };
  }
  if (isSeriesCode(code) && extra === undefined) return { type: SERIES_ACTIONS[code], tmdbId };
  return null;
}

export function keyboard(rows: readonly (readonly Button[])[]): InlineKeyboard {
  return InlineKeyboard.from(
    rows.map((row) => row.map((button) => InlineKeyboard.text(button.text, encodeAction(button.action)))),
  );
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const truncate = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);

export function cardHtml(card: SeriesCard): string {
  const lines = [`<b>${escapeHtml(card.name)}</b>${card.year === null ? "" : ` (${card.year})`}`];
  if (card.originalName !== card.name) lines.push(`<i>${escapeHtml(card.originalName)}</i>`);
  lines.push(
    "",
    card.overview ? escapeHtml(truncate(card.overview, MAX_OVERVIEW)) : "Описание в каталоге отсутствует.",
  );
  if (card.upcoming) {
    lines.push("", `Ближайшая премьера: ${card.upcoming.seasonNumber}-й сезон — ${formatDate(card.upcoming.date)}`);
  }
  if (card.explanation) lines.push("", `<b>Почему:</b> ${escapeHtml(card.explanation)}`);
  lines.push("", `<a href="${seriesUrl(card.tmdbId)}">Карточка на TMDB</a>`);
  return lines.join("\n");
}

export function cardButtons(tmdbId: number): Button[][] {
  return [
    [
      { text: "В список", action: { type: "want", tmdbId } },
      { text: "Смотрел", action: { type: "watched", tmdbId } },
    ],
    [
      { text: "Не интересно", action: { type: "not_interested", tmdbId } },
      { text: "Следить за сезонами", action: { type: "follow", tmdbId } },
    ],
  ];
}

export type RenderedMessage = {
  readonly text: string;
  readonly options: {
    parse_mode?: "HTML";
    reply_markup?: InlineKeyboard;
    link_preview_options?: { is_disabled: true };
  };
};

export function render(message: OutgoingMessage): RenderedMessage {
  if (message.kind === "series") {
    return {
      text: cardHtml(message.card),
      options: {
        parse_mode: "HTML",
        reply_markup: keyboard(cardButtons(message.card.tmdbId)),
        link_preview_options: { is_disabled: true },
      },
    };
  }
  const buttons = message.buttons ?? [];
  return {
    text: truncate(message.text, MAX_TEXT),
    options: {
      ...(buttons.length > 0 ? { reply_markup: keyboard(buttons) } : {}),
      link_preview_options: { is_disabled: true },
    },
  };
}
