import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelContractError } from "../src/application/errors.ts";
import { createRecommendations, MAX_CANDIDATES } from "../src/application/recommendations.ts";
import { applyFeedback } from "../src/domain/library.ts";
import type { Profile } from "../src/domain/profile.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";
import { type FakeCatalog, fakeCatalog, type ScriptedModel, scriptedModel, series } from "./support/fakes.ts";

// 2026-10-17 12:00 в Новосибирске.
const NOW = Date.UTC(2026, 9, 17, 5, 0);

const LIKED = series(1, "Тьма", { genreIds: [18, 9648] });
const PROFILE: Profile = {
  summary: "Мрачные детективы",
  themes: [],
  mood: [],
  pace: null,
  avoid: [],
  titles: [{ tmdbId: 1, name: "Тьма", year: 2017, genreIds: [18, 9648], sentiment: "liked", reason: null }],
};

let test: TestDatabase;
let catalog: FakeCatalog;
let model: ScriptedModel;
let ids = 0;

function service() {
  return createRecommendations({
    store: test.store,
    profiles: test.store,
    library: test.store,
    subscriptions: test.store,
    recommendations: test.store,
    outbox: test.store,
    catalog,
    model,
    clock: { now: () => NOW },
    newId: () => `batch-${++ids}`,
    timeZone: "Asia/Novosibirsk",
  });
}

const candidateIds = () => model.rankingInputs.at(-1)?.candidates.map((candidate) => candidate.tmdbId) ?? [];

beforeEach(() => {
  test = createTestDatabase();
  test.store.confirmProfile(PROFILE);
  catalog = fakeCatalog([LIKED]);
  model = scriptedModel();
});

afterEach(() => {
  test.cleanup();
});

describe("подборка", () => {
  it("исключает просмотренные, отклонённые, сохранённые, отслеживаемые и уже предложенные сериалы", async () => {
    const pool = [10, 11, 12, 13, 14, 15].map((id) => series(id, `Сериал ${id}`));
    for (const item of pool) catalog.seriesById.set(item.tmdbId, item);
    catalog.recommendations = { 1: [LIKED, ...pool] };
    const ref = (id: number) => ({ tmdbId: id, name: `Сериал ${id}`, year: 2020 });
    test.store.saveEntry(applyFeedback(null, ref(10), { kind: "watched" }));
    test.store.saveEntry(applyFeedback(null, ref(11), { kind: "not_interested" }));
    test.store.saveEntry(applyFeedback(null, ref(12), { kind: "want_to_watch" }));
    test.store.saveSubscription({ ...ref(13), active: true });
    model.ranking = () => [{ tmdbId: 14, explanation: "Похож на «Тьму»" }];
    await service().recommend("manual:1");
    expect(candidateIds()).toEqual([14, 15]);

    model.ranking = () => [];
    await service().recommend("manual:2");
    expect(candidateIds()).toEqual([15]);
  });

  it("учитывает новую обратную связь: понравившийся сериал становится источником похожих", async () => {
    catalog.recommendations = { 1: [], 20: [series(21, "Похожий на 20")] };
    test.store.saveEntry({
      ...applyFeedback(null, { tmdbId: 20, name: "Сериал 20", year: 2021 }, { kind: "rated", rating: "liked" }),
      comment: "отличные диалоги",
    });
    await service().recommend("manual:1");
    expect(candidateIds()).toEqual([21]);
    expect(model.rankingInputs[0]?.feedback.liked).toEqual([{ name: "Сериал 20", comment: "отличные диалоги" }]);
  });

  it("сохраняет подборку с сообщениями до отправки, повторный запуск с тем же ключом не вызывает модель", async () => {
    catalog.recommendations = { 1: [series(30, "Кандидат")] };
    expect(await service().recommend("weekly:1")).toEqual({ status: "created", count: 1 });
    expect(await service().recommend("weekly:1")).toEqual({ status: "existing", count: 1 });
    expect(model.rankingInputs).toHaveLength(1);

    const messages = test.store.dueMessages(NOW).map((item) => item.message);
    expect(messages[1]).toMatchObject({ kind: "series", card: { tmdbId: 30, explanation: "Подходит: Кандидат" } });
  });

  it("отклоняет выдуманный моделью ID и ничего не сохраняет", async () => {
    catalog.recommendations = { 1: [series(30, "Кандидат")] };
    model.ranking = () => [{ tmdbId: 999, explanation: "Выдуманный" }];
    await expect(service().recommend("manual:1")).rejects.toBeInstanceOf(ModelContractError);
    expect(test.store.findBatch("manual:1")).toBeNull();
    expect(test.store.countPending()).toBe(0);
  });

  it("отклоняет повтор одного сериала в ответе модели", async () => {
    catalog.recommendations = { 1: [series(30, "Кандидат"), series(31, "Другой")] };
    model.ranking = () => [
      { tmdbId: 30, explanation: "Раз" },
      { tmdbId: 30, explanation: "Два" },
    ];
    await expect(service().recommend("manual:1")).rejects.toThrow("повторила");
  });

  it("без кандидатов не вызывает модель и сообщает об этом", async () => {
    expect(await service().recommend("manual:1")).toEqual({ status: "created", count: 0 });
    expect(model.rankingInputs).toHaveLength(0);
    const [message] = test.store.dueMessages(NOW).map((item) => item.message);
    expect(message).toMatchObject({ kind: "text", text: expect.stringContaining("Новых кандидатов не нашлось") });
  });

  it("если модель не выбрала ни одного, сообщает, что подходящих нет", async () => {
    catalog.recommendations = { 1: [series(30, "Кандидат")] };
    model.ranking = () => [];
    await service().recommend("manual:1");
    const [message] = test.store.dueMessages(NOW).map((item) => item.message);
    expect(message).toMatchObject({ text: expect.stringContaining("не нашлось подходящих") });
  });

  it("без профиля подборка не строится", async () => {
    test.reopen();
    test.db.exec("DELETE FROM profile");
    expect(await service().recommend("manual:1")).toEqual({ status: "no_profile" });
  });

  it("будущая премьера попадает в кандидаты только с датой сезона в пределах 180 дней", async () => {
    const soon = series(40, "Скоро", { seasons: [{ number: 2, airDate: "2027-01-10" }] });
    const late = series(41, "Не скоро", { seasons: [{ number: 2, airDate: "2027-12-01" }] });
    const ongoing = series(42, "Идёт сезон", { seasons: [{ number: 1, airDate: "2026-09-01" }] });
    for (const item of [soon, late, ongoing]) catalog.seriesById.set(item.tmdbId, item);
    catalog.discoverResults = (query) => (query.airDateFrom ? [soon, late, ongoing] : []);
    await service().recommend("manual:1");

    const [candidate, ...rest] = model.rankingInputs[0]?.candidates ?? [];
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      tmdbId: 40,
      source: "upcoming",
      upcoming: { seasonNumber: 2, date: "2027-01-10" },
    });
    expect(
      catalog.calls.find((call) => call.method === "discover" && JSON.stringify(call.args).includes("airDateTo")),
    ).toMatchObject({ args: [{ airDateFrom: "2026-10-17", airDateTo: "2027-04-15", genreIds: [18, 9648] }] });
  });

  it("без русского описания берёт описание из карточки, без описания вовсе — пропускает", async () => {
    const english = series(50, "English only", { overview: "English overview" });
    const none = series(51, "Без описания", { overview: null });
    catalog.seriesById.set(50, english);
    catalog.seriesById.set(51, none);
    catalog.recommendations = {
      1: [
        { ...english, overview: null },
        { ...none, overview: null },
      ],
    };
    await service().recommend("manual:1");
    expect(model.rankingInputs[0]?.candidates).toEqual([
      expect.objectContaining({ tmdbId: 50, overview: "English overview" }),
    ]);
  });

  it(`ограничивает вход модели ${MAX_CANDIDATES} кандидатами и распределяет места между источниками`, async () => {
    const make = (from: number) => Array.from({ length: 50 }, (_, index) => series(from + index, `S${from + index}`));
    catalog.recommendations = { 1: make(1000) };
    catalog.discoverResults = (query) => (query.airDateFrom ? [] : make(2000));
    await service().recommend("manual:1");
    const sources = model.rankingInputs[0]?.candidates.map((candidate) => candidate.source) ?? [];
    expect(sources).toHaveLength(MAX_CANDIDATES);
    expect(sources.filter((source) => source === "similar")).toHaveLength(30);
    expect(sources.filter((source) => source === "genre")).toHaveLength(30);
  });
});
