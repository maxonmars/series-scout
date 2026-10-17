import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { ExternalServiceError, type FailureKind } from "../../application/errors.ts";
import type { TasteModelPort } from "../../application/ports.ts";
import type { ReportHealth } from "../http.ts";

const BASE_URL = "https://api.deepseek.com";

export type DeepSeekOptions = {
  readonly apiKey: string;
  readonly model: string;
  readonly prompts: { readonly interview: string; readonly ranking: string };
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly reportHealth?: ReportHealth;
};

const stringList = z.array(z.string()).default([]);

const interviewResponse = z.object({
  draft: z.object({
    summary: z.string().default(""),
    themes: stringList,
    mood: stringList,
    pace: z.string().nullable().default(null),
    avoid: stringList,
  }),
  titles: z
    .array(
      z.object({
        query: z.string().trim().min(1),
        sentiment: z.enum(["liked", "disliked"]),
        reason: z.string().nullable().default(null),
      }),
    )
    .default([]),
  removedTitles: stringList,
  question: z.string().nullable().default(null),
});

const rankingResponse = z.object({
  items: z.array(z.object({ tmdbId: z.number().int(), explanation: z.string().trim().min(1) })),
});

function failureKind(error: unknown): FailureKind {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIConnectionError) return "unavailable";
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return "auth";
    if (error.status === 402 || error.status === 403) return "forbidden";
    if (error.status === 429) return "rate_limit";
    if (error.status !== undefined && error.status >= 500) return "unavailable";
    return "rejected";
  }
  return "unavailable";
}

function formatProblem(raw: string, schema: z.ZodType): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "ответ не является корректным JSON";
  }
  const result = schema.safeParse(parsed);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return `поле ${issue?.path.join(".") || "(корень)"}: ${issue?.message ?? "не соответствует схеме"}`;
}

export type DeepSeekTasteModel = TasteModelPort & { readonly listModels: () => Promise<string[]> };

export function createDeepSeekTasteModel(options: DeepSeekOptions): DeepSeekTasteModel {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? BASE_URL,
    timeout: options.timeoutMs ?? 90_000,
    maxRetries: 0,
    fetch: options.fetch,
  });

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      options.reportHealth?.("deepseek", null);
      return result;
    } catch (error) {
      const failure = new ExternalServiceError(
        "deepseek",
        failureKind(error),
        error instanceof OpenAI.APIError ? error.status : undefined,
      );
      options.reportHealth?.("deepseek", failure);
      throw failure;
    }
  }

  /** JSON Output с проверкой схемы; невалидный ответ модель исправляет один раз. */
  async function completeJson<T>(system: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await call(() =>
        client.chat.completions.create({
          model: options.model,
          messages,
          response_format: { type: "json_object" },
          max_tokens: options.maxOutputTokens ?? 2_000,
        }),
      );
      const choice = response.choices[0];
      const content = choice?.message.content ?? "";
      if (content.trim() === "") throw new ExternalServiceError("deepseek", "empty_response");
      const problem =
        choice?.finish_reason === "length" ? "ответ обрезан по лимиту длины" : formatProblem(content, schema);
      if (problem === null) return schema.parse(JSON.parse(content));
      if (attempt === 2) break;
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: `Ответ не прошёл проверку: ${problem}. Верни только JSON-объект по описанному формату.`,
        },
      );
    }
    throw new ExternalServiceError("deepseek", "invalid_response");
  }

  return {
    async interviewStep(input) {
      const result = await completeJson(options.prompts.interview, input, interviewResponse);
      return {
        draft: result.draft,
        mentionedTitles: result.titles,
        removedTitles: result.removedTitles,
        question: result.question?.trim() || null,
      };
    },

    async rankCandidates(input) {
      return (await completeJson(options.prompts.ranking, input, rankingResponse)).items;
    },

    async listModels() {
      const page = await call(() => client.models.list());
      return page.data.map((model) => model.id);
    },
  };
}
