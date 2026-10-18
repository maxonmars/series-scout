import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoogleCalendar } from "../src/adapters/google/calendar.ts";
import { OperationError } from "../src/application/errors.ts";
import type { CalendarEvent } from "../src/application/ports.ts";

const EVENT: CalendarEvent = {
  eventId: "ss1s2g1",
  premiereKey: "1:2",
  date: "2026-12-31",
  summary: "«Разделение»: 2-й сезон",
  description: "Премьера",
};

type Call = { method: string; url: URL; body: unknown; authorization: string | null };

function setup(route: (call: Call) => Response) {
  const calls: Call[] = [];
  const calendar = createGoogleCalendar({
    calendarId: "series@group.calendar.google.com",
    credentialsPath: "/не/используется",
    getAccessToken: async () => "access-token",
    sleep: async () => {},
    fetch: async (input, init) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      return route(call);
    },
  });
  return { calendar, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const owned = (premiereKey = "1:2", status = "confirmed") =>
  json({ id: "ss1s2g1", status, extendedProperties: { private: { app: "series-scout", premiereKey } } });

describe("Google Calendar", () => {
  it("создаёт событие на весь день без занятости, с меткой продукта и ключом премьеры", async () => {
    const { calendar, calls } = setup(() => json({ id: "ss1s2g1" }));
    await calendar.createEvent(EVENT);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/calendar/v3/calendars/series%40group.calendar.google.com/events");
    expect(calls[0]?.authorization).toBe("Bearer access-token");
    expect(calls[0]?.body).toEqual({
      id: "ss1s2g1",
      status: "confirmed",
      summary: EVENT.summary,
      description: EVENT.description,
      start: { date: "2026-12-31" },
      end: { date: "2027-01-01" },
      transparency: "transparent",
      extendedProperties: { private: { app: "series-scout", premiereKey: "1:2" } },
    });
  });

  it("конфликт ID при создании разрешает чтением своего события и обновлением", async () => {
    const { calendar, calls } = setup((call) => {
      if (call.method === "POST") return json({ error: {} }, 409);
      if (call.method === "GET") return owned("1:2", "cancelled");
      return json({ id: "ss1s2g1" });
    });
    await calendar.createEvent(EVENT);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "PUT"]);
    expect(calls[2]?.body).toMatchObject({ status: "confirmed", start: { date: "2026-12-31" } });
  });

  it("не изменяет событие без метки Series Scout", async () => {
    const { calendar, calls } = setup((call) => (call.method === "GET" ? json({ id: "ss1s2g1" }) : json({})));
    await expect(calendar.updateEvent(EVENT)).rejects.toBeInstanceOf(OperationError);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("обновление отсутствующего события сообщает missing", async () => {
    const { calendar } = setup(() => json({ error: {} }, 404));
    expect(await calendar.updateEvent(EVENT)).toBe("missing");
  });

  it("удаление уже удалённого события считается выполненным", async () => {
    const { calendar, calls } = setup(() => json({ error: {} }, 410));
    await calendar.deleteEvent("ss1s2g1");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("удаляет своё событие", async () => {
    const { calendar, calls } = setup((call) =>
      call.method === "GET" ? owned() : new Response(null, { status: 204 }),
    );
    await calendar.deleteEvent("ss1s2g1");
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
  });

  it("нет прав на календарь — понятная причина", async () => {
    const { calendar } = setup(() => json({ error: {} }, 403));
    await expect(calendar.createEvent(EVENT)).rejects.toMatchObject({ service: "google", kind: "forbidden" });
  });

  it("временную ошибку повторяет", async () => {
    let attempts = 0;
    const { calendar } = setup(() => (++attempts < 3 ? json({}, 503) : json({ id: "ss1s2g1" })));
    await calendar.createEvent(EVENT);
    expect(attempts).toBe(3);
  });
});

describe("Google Calendar: ключ сервисного аккаунта", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "series-scout-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function keyFile(content: unknown): string {
    const path = join(dir, "google.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("подписывает запрос токена с client_email из файла ключа в iss", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const credentialsPath = keyFile({
      type: "service_account",
      client_email: "bot@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    const claims: unknown[] = [];
    let authorization: string | null = null;
    const calendar = createGoogleCalendar({
      calendarId: "series@group.calendar.google.com",
      credentialsPath,
      sleep: async () => {},
      fetch: async (input, init) => {
        if (String(input).startsWith("https://oauth2.googleapis.com/token")) {
          const assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
          claims.push(JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()));
          return json({ access_token: "service-token", token_type: "Bearer", expires_in: 3600 });
        }
        authorization = new Headers(init?.headers).get("authorization");
        return json({ items: [] });
      },
    });
    await calendar.verifyAccess();
    expect(claims).toEqual([
      expect.objectContaining({
        iss: "bot@project.iam.gserviceaccount.com",
        scope: "https://www.googleapis.com/auth/calendar.events",
      }),
    ]);
    expect(authorization).toBe("Bearer service-token");
  });

  it("файл без client_email и private_key отклоняет до сетевых запросов", async () => {
    let requests = 0;
    const calendar = createGoogleCalendar({
      calendarId: "series@group.calendar.google.com",
      credentialsPath: keyFile({ type: "authorized_user" }),
      fetch: async () => {
        requests++;
        return json({});
      },
    });
    await expect(calendar.verifyAccess()).rejects.toThrow(/не похож на JSON-ключ сервисного аккаунта/);
    expect(requests).toBe(0);
  });
});
