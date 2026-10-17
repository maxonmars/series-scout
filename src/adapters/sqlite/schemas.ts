import { z } from "zod";
import type { OutgoingMessage, PendingInput, SeriesCard } from "../../application/ports.ts";
import type { InterviewState } from "../../domain/interview.ts";
import type { Profile } from "../../domain/profile.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sentiment = z.enum(["liked", "disliked"]);

const draft = z.object({
  summary: z.string(),
  themes: z.array(z.string()),
  mood: z.array(z.string()),
  pace: z.string().nullable(),
  avoid: z.array(z.string()),
});

const profileTitle = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  year: z.number().int().nullable(),
  genreIds: z.array(z.number().int()),
  sentiment,
  reason: z.string().nullable(),
});

export const profileSchema: z.ZodType<Profile> = draft.extend({ titles: z.array(profileTitle) });

export const interviewSchema: z.ZodType<InterviewState> = z.object({
  mode: z.enum(["new", "edit"]),
  step: z.enum(["asking", "resolving", "confirming"]),
  conversation: z.array(z.object({ role: z.enum(["bot", "user"]), text: z.string() })),
  clarifications: z.number().int(),
  draft,
  titles: z.array(profileTitle),
  pending: z.array(
    z.object({
      query: z.string(),
      sentiment,
      reason: z.string().nullable(),
      options: z.array(
        z.object({
          tmdbId: z.number().int(),
          name: z.string(),
          year: z.number().int().nullable(),
          genreIds: z.array(z.number().int()),
        }),
      ),
    }),
  ),
  nextQuestion: z.string().nullable(),
});

export const pendingInputSchema: z.ZodType<PendingInput> = z.union([
  z.object({ kind: z.literal("search") }),
  z.object({ kind: z.literal("comment"), tmdbId: z.number().int() }),
]);

export const seriesCardSchema: z.ZodType<SeriesCard> = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  originalName: z.string(),
  year: z.number().int().nullable(),
  overview: z.string().nullable(),
  upcoming: z.object({ seasonNumber: z.number().int(), date: isoDate }).nullable(),
  explanation: z.string().nullable(),
});

const tmdbAction = z.object({
  type: z.enum(["want", "watched", "not_interested", "follow", "unfollow", "pick_title"]),
  tmdbId: z.number().int(),
});

const button = z.object({
  text: z.string(),
  action: z.union([
    tmdbAction,
    z.object({ type: z.literal("rate"), tmdbId: z.number().int(), rating: sentiment }),
    z.object({
      type: z.enum([
        "skip_comment",
        "skip_title",
        "finish_interview",
        "confirm_profile",
        "cancel_profile",
        "edit_profile",
      ]),
    }),
  ]),
});

export const outgoingMessageSchema: z.ZodType<OutgoingMessage> = z.union([
  z.object({ kind: z.literal("text"), text: z.string(), buttons: z.array(z.array(button)).optional() }),
  z.object({ kind: z.literal("series"), card: seriesCardSchema }),
]);

/** Повреждённая запись — ошибка приложения, а не повод молча потерять состояние. */
export function parseStored<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(JSON.parse(String(raw)));
  if (!parsed.success) throw new Error(`Повреждённая запись в базе: ${what}`);
  return parsed.data;
}
