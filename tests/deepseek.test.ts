import { describe, expect, it } from "vitest";
import { createDeepSeekTasteModel } from "../src/adapters/deepseek/taste-model.ts";
import { ExternalServiceError } from "../src/application/errors.ts";
import type { RankingInput } from "../src/application/ports.ts";

const RANKING_INPUT: RankingInput = {
  profile: { summary: "Детективы", themes: [], mood: [], pace: null, avoid: [], titles: [] },
  feedback: { liked: [], disliked: [], notInterested: [] },
  candidates: [
    {
      tmdbId: 7,
      name: "Кандидат",
      originalName: "Candidate",
      year: 2020,
      overview: "О",
      source: "genre",
      upcoming: null,
    },
  ],
  limit: 3,
};

function completion(content: string | null, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function setup(responses: ((init: RequestInit) => Response | Promise<Response>)[], timeoutMs?: number) {
  const bodies: Record<string, unknown>[] = [];
  const model = createDeepSeekTasteModel({
    apiKey: "sk-test",
    model: "deepseek-flash",
    prompts: { interview: "interview prompt json", ranking: "ranking prompt json" },
    timeoutMs,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = responses.shift();
      if (!next) throw new Error("лишний запрос к модели");
      return next(init ?? {});
    },
  });
  return { model, bodies };
}

describe("DeepSeek", () => {
  it("запрашивает JSON Output у заданной модели и возвращает проверенный результат", async () => {
    const { model, bodies } = setup([() => completion('{"items":[{"tmdbId":7,"explanation":"Подходит"}]}')]);
    expect(await model.rankCandidates(RANKING_INPUT)).toEqual([{ tmdbId: 7, explanation: "Подходит" }]);
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash", response_format: { type: "json_object" } });
  });

  it("повреждённый JSON исправляется одним повтором с описанием проблемы", async () => {
    const { model, bodies } = setup([
      () => completion('{"items": [oops'),
      () => completion('{"items":[{"tmdbId":7,"explanation":"Подходит"}]}'),
    ]);
    expect(await model.rankCandidates(RANKING_INPUT)).toHaveLength(1);
    const retryMessages = bodies[1]?.messages as { role: string; content: string }[];
    expect(retryMessages.at(-1)?.content).toContain("не является корректным JSON");
  });

  it("повторная ошибка формата завершает операцию", async () => {
    const { model, bodies } = setup([() => completion('{"items":"нет"}'), () => completion('{"wrong":true}')]);
    await expect(model.rankCandidates(RANKING_INPUT)).rejects.toMatchObject({
      service: "deepseek",
      kind: "invalid_response",
    });
    expect(bodies).toHaveLength(2);
  });

  it("пустой ответ — ошибка без повтора", async () => {
    const { model, bodies } = setup([() => completion("")]);
    await expect(model.rankCandidates(RANKING_INPUT)).rejects.toMatchObject({ kind: "empty_response" });
    expect(bodies).toHaveLength(1);
  });

  it("обрезанный по длине ответ считается невалидным", async () => {
    const { model } = setup([() => completion('{"items":[]}', "length"), () => completion('{"items":[]}', "length")]);
    await expect(model.rankCandidates(RANKING_INPUT)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("тайм-аут модели превращается в ошибку timeout", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { model } = setup([hang], 10);
    const error = await model.rankCandidates(RANKING_INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error).toMatchObject({ kind: "timeout" });
  });

  it("отклонённый ключ — ошибка авторизации", async () => {
    const { model } = setup([() => new Response('{"error":{"message":"bad key"}}', { status: 401 })]);
    await expect(model.rankCandidates(RANKING_INPUT)).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("шаг интервью: заполняет пропущенные поля значениями по умолчанию", async () => {
    const { model } = setup([
      () => completion('{"draft":{"summary":"Любит детективы"},"titles":[{"query":"Тьма","sentiment":"liked"}]}'),
    ]);
    const result = await model.interviewStep({
      mode: "new",
      conversation: [{ role: "user", text: "Нравится Тьма" }],
      clarificationsLeft: 4,
      draft: { summary: "", themes: [], mood: [], pace: null, avoid: [] },
      titles: [],
    });
    expect(result).toEqual({
      draft: { summary: "Любит детективы", themes: [], mood: [], pace: null, avoid: [] },
      mentionedTitles: [{ query: "Тьма", sentiment: "liked", reason: null }],
      removedTitles: [],
      question: null,
    });
  });
});
