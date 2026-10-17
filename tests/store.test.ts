import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseLockedError, openDatabase, SCHEMA_VERSION } from "../src/adapters/sqlite/database.ts";
import { applyFeedback } from "../src/domain/library.ts";
import type { Profile } from "../src/domain/profile.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";

const PROFILE: Profile = {
  summary: "Мрачные детективы с медленным темпом",
  themes: ["расследование"],
  mood: ["мрачная"],
  pace: "медленный",
  avoid: ["ситкомы"],
  titles: [{ tmdbId: 1, name: "Тьма", year: 2017, genreIds: [18], sentiment: "liked", reason: "запутанный сюжет" }],
};

let test: TestDatabase;

beforeEach(() => {
  test = createTestDatabase();
});

afterEach(() => {
  test.cleanup();
});

describe("SQLite-хранилище", () => {
  it("сохраняет профиль, библиотеку и подписки после переоткрытия базы", () => {
    test.store.confirmProfile(PROFILE);
    test.store.saveEntry(applyFeedback(null, { tmdbId: 2, name: "Ход королевы", year: 2020 }, { kind: "watched" }));
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: true });
    test.store.savePremieres(3, [{ seasonNumber: 2, airDate: "2027-01-17", todayNotifiedOn: null }]);

    test.reopen();

    expect(test.store.getProfile()).toEqual(PROFILE);
    expect(test.store.getEntry(2)?.watched).toBe(true);
    expect(test.store.getSubscription(3)?.active).toBe(true);
    expect(test.store.getPremieres(3)).toEqual([{ seasonNumber: 2, airDate: "2027-01-17", todayNotifiedOn: null }]);
  });

  it("откатывает транзакцию целиком при ошибке внутри неё", () => {
    expect(() =>
      test.store.transaction(() => {
        test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: true });
        throw new Error("сбой посреди транзакции");
      }),
    ).toThrow("сбой посреди транзакции");
    expect(test.store.getSubscription(3)).toBeNull();
  });

  it("повторная подписка обновляет единственную запись", () => {
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: true });
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: false });
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: true });
    expect(test.store.listSubscriptions()).toEqual([{ tmdbId: 3, name: "Разделение", year: 2022, active: true }]);
  });

  it("отметка о просмотре не затрагивает подписку и наоборот", () => {
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: true });
    test.store.saveEntry(applyFeedback(null, { tmdbId: 3, name: "Разделение", year: 2022 }, { kind: "watched" }));
    test.store.saveSubscription({ tmdbId: 3, name: "Разделение", year: 2022, active: false });

    expect(test.store.getEntry(3)?.watched).toBe(true);
    expect(test.store.getSubscription(3)?.active).toBe(false);
  });

  it("подтверждение профиля завершает интервью, прежний профиль действует до подтверждения", () => {
    test.store.confirmProfile(PROFILE);
    test.store.saveInterview({
      mode: "edit",
      step: "asking",
      conversation: [],
      clarifications: 0,
      draft: { ...PROFILE, summary: "Новый черновик" },
      titles: [],
      pending: [],
      nextQuestion: null,
    });
    expect(test.store.getProfile()?.summary).toBe(PROFILE.summary);

    test.store.confirmProfile({ ...PROFILE, summary: "Новый черновик" });
    expect(test.store.getInterview()).toBeNull();
    expect(test.store.getProfile()?.summary).toBe("Новый черновик");
  });

  it("одна логическая доставка ставится в очередь один раз", () => {
    const message = { kind: "text", text: "Премьера сегодня" } as const;
    test.store.enqueue("premiere-check:1", [message], 10);
    test.store.enqueue("premiere-check:1", [message], 20);
    expect(test.store.dueMessages(30)).toHaveLength(1);
  });

  it("одна подборка на ключ запуска", () => {
    const batch = { id: "b1", triggerKey: "weekly:1", createdAt: 1, items: [] };
    test.store.saveBatch(batch);
    expect(() => test.store.saveBatch({ ...batch, id: "b2" })).toThrow();
    expect(test.store.findBatch("weekly:1")?.id).toBe("b1");
  });

  it("версионирует схему и отказывается открывать базу более новой версии", () => {
    expect(Number(test.db.prepare("PRAGMA user_version").get()?.user_version)).toBe(SCHEMA_VERSION);
    test.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    test.db.close();
    expect(() => openDatabase(test.path)).toThrow("новее поддерживаемой");
  });

  it("монопольный режим не даёт второму процессу открыть ту же базу", () => {
    test.db.close();
    const first = openDatabase(test.path, { exclusive: true });
    try {
      expect(() => openDatabase(test.path, { exclusive: true })).toThrow(DatabaseLockedError);
    } finally {
      first.close();
    }
  });
});
