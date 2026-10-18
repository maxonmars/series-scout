import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInterview } from "../src/application/interview.ts";
import { MAX_CLARIFICATIONS } from "../src/domain/interview.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";
import {
  buttonsOf,
  draftWith,
  type FakeCatalog,
  fakeCatalog,
  type ScriptedModel,
  scriptedModel,
  series,
  textOf,
} from "./support/fakes.ts";

const DARK_2017 = series(1, "Тьма", { firstAirDate: "2017-12-01" });
const DARK_2010 = series(2, "Тьма", { firstAirDate: "2010-05-01", genreIds: [35] });
const OFFICE = series(3, "Офис", { firstAirDate: "2005-03-24" });

let test: TestDatabase;
let catalog: FakeCatalog;
let model: ScriptedModel;

const interview = () => createInterview({ profiles: test.store, catalog, model });

beforeEach(() => {
  test = createTestDatabase();
  catalog = fakeCatalog([DARK_2017, DARK_2010, OFFICE]);
  catalog.searchResults = { Тьма: [DARK_2017, DARK_2010], "Офис США": [OFFICE] };
  model = scriptedModel();
});

afterEach(() => {
  test.cleanup();
});

describe("интервью", () => {
  it("неоднозначное название подтверждает пользователь, ID выбирается по карточке, а не моделью", async () => {
    expect(textOf(interview().start())).toContain("Расскажите, какие сериалы");

    model.interview = () => ({
      draft: draftWith("Любит мрачные детективы"),
      mentionedTitles: [{ query: "Тьма", sentiment: "liked", reason: "запутанный сюжет" }],
      question: "Что важнее: загадка или персонажи?",
    });
    const resolving = await interview().handleText("Обожаю Тьму за запутанный сюжет");
    expect(textOf(resolving)).toContain("Какой сериал вы имели в виду под «Тьма»");
    expect(buttonsOf(resolving)).toEqual(["«Тьма» (2017)", "«Тьма» (2010)", "Пропустить"]);

    const question = interview().pickTitle(DARK_2017.tmdbId);
    expect(textOf(question)).toContain("Что важнее");
    expect(buttonsOf(question)).toContain("Готово, показать итог");

    const summary = interview().finish();
    expect(textOf(summary)).toContain("«Тьма» (2017) — запутанный сюжет");
    expect(textOf(interview().confirm())).toContain("Профиль сохранён");

    const profile = test.store.getProfile();
    expect(profile?.titles).toEqual([
      { tmdbId: 1, name: "Тьма", year: 2017, genreIds: [18], sentiment: "liked", reason: "запутанный сюжет" },
    ]);
    expect(test.store.getInterview()).toBeNull();
  });

  it("продолжается после перезапуска с того же шага", async () => {
    interview().start();
    model.interview = () => ({ mentionedTitles: [{ query: "Тьма", sentiment: "liked", reason: null }] });
    await interview().handleText("Нравится Тьма");

    test.reopen();

    const resumed = interview().start();
    expect(textOf(resumed)).toContain("под «Тьма»");
    expect(model.interviewInputs).toHaveLength(1);
  });

  it("ненайденное название можно исправить текстом или пропустить", async () => {
    interview().start();
    model.interview = () => ({
      mentionedTitles: [{ query: "Офис американский", sentiment: "disliked", reason: null }],
    });
    expect(textOf(await interview().handleText("Не люблю Офис американский"))).toContain(
      "Не нашёл «Офис американский»",
    );

    const corrected = await interview().handleText("Офис США");
    expect(buttonsOf(corrected)).toEqual(["«Офис» (2005)", "Пропустить"]);
    expect(model.interviewInputs).toHaveLength(1);

    interview().skipTitle();
    expect(test.store.getInterview()?.titles).toEqual([]);
    expect(test.store.getInterview()?.step).toBe("confirming");
  });

  it("выбор варианта из устаревшей карточки не меняет состояние", async () => {
    interview().start();
    model.interview = () => ({ mentionedTitles: [{ query: "Тьма", sentiment: "liked", reason: null }] });
    await interview().handleText("Нравится Тьма");
    const before = test.store.getInterview();

    expect(textOf(interview().pickTitle(OFFICE.tmdbId))).toContain("неактуален");
    expect(test.store.getInterview()).toEqual(before);
  });

  it(`после ${MAX_CLARIFICATIONS} уточнений показывает итог, даже если модель хочет спросить ещё`, async () => {
    interview().start();
    model.interview = (input) => ({
      draft: draftWith("Любит детективы"),
      question: `Вопрос ${input.clarificationsLeft}`,
    });
    for (let index = 0; index < MAX_CLARIFICATIONS; index++) {
      expect(textOf(await interview().handleText(`ответ ${index}`))).toContain("Вопрос");
    }
    const last = await interview().handleText("последний ответ");
    expect(textOf(last)).toContain("Итог профиля");
    expect(model.interviewInputs.at(-1)?.clarificationsLeft).toBe(0);
  });

  it("не сохраняет профиль без любимого сериала и описания", async () => {
    interview().start();
    const summary = interview().finish();
    expect(textOf(summary)).toContain("Пока недостаточно сведений");
    expect(buttonsOf(summary)).not.toContain("Сохранить профиль");
    expect(textOf(interview().confirm())).toContain("недостаточно");
    expect(test.store.getProfile()).toBeNull();
  });

  it("при изменении прежний профиль действует до подтверждения, отмена его сохраняет", async () => {
    test.store.confirmProfile({ ...draftWith("Прежний профиль"), titles: [] });
    expect(textOf(interview().edit())).toContain("Прежний профиль");

    model.interview = () => ({ draft: draftWith("Новый профиль") });
    const summary = await interview().handleText("Теперь хочу комедии");
    expect(buttonsOf(summary)).toContain("Отменить изменения");
    expect(test.store.getProfile()?.summary).toBe("Прежний профиль");

    expect(textOf(interview().cancel())).toContain("действует прежний профиль");
    expect(test.store.getProfile()?.summary).toBe("Прежний профиль");
    expect(test.store.getInterview()).toBeNull();
  });

  it("убирает из профиля сериал, который пользователь попросил убрать", async () => {
    const dark = { tmdbId: 1, name: "Тьма", year: 2017, genreIds: [18], sentiment: "liked" as const, reason: null };
    test.store.confirmProfile({ ...draftWith("Детективы"), titles: [dark] });
    interview().edit();
    model.interview = () => ({ removedTitles: ["Тьма"], draft: draftWith("Детективы") });
    await interview().handleText("Убери Тьму");
    expect(test.store.getInterview()?.titles).toEqual([]);
  });

  it("ошибка модели не продвигает интервью и не теряет прежнее состояние", async () => {
    interview().start();
    const before = test.store.getInterview();
    model.interview = () => {
      throw new Error("DeepSeek недоступен");
    };
    await expect(interview().handleText("ответ")).rejects.toThrow("DeepSeek недоступен");
    expect(test.store.getInterview()).toEqual(before);
  });
});
