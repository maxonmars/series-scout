import { readFile } from "node:fs/promises";
import { JWT } from "google-auth-library";
import { z } from "zod";
import { ExternalServiceError, OperationError } from "../../application/errors.ts";
import type { CalendarEvent, CalendarPort } from "../../application/ports.ts";
import { PRODUCT_ID } from "../../domain/calendar.ts";
import { addDays } from "../../domain/dates.ts";
import { createHttpClient, type HttpClientOptions } from "../http.ts";

const BASE_URL = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const FILE_ERRORS = new Set(["ENOENT", "EACCES", "EISDIR"]);
const NETWORK_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

export type GoogleCalendarOptions = Omit<HttpClientOptions, "service"> & {
  readonly calendarId: string;
  /** Путь к JSON-ключу сервисного аккаунта. */
  readonly credentialsPath: string;
  readonly baseUrl?: string;
  /** Подмена получения токена в тестах. */
  readonly getAccessToken?: () => Promise<string>;
};

const storedEvent = z.object({
  id: z.string(),
  status: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});

const serviceAccountKey = z.object({ client_email: z.string().min(1), private_key: z.string().min(1) });

function tokenFailure(error: unknown): Error {
  if (error instanceof OperationError) return error;
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (FILE_ERRORS.has(code)) {
    return new OperationError(
      "Google Calendar: файл ключа сервисного аккаунта недоступен — проверьте GOOGLE_APPLICATION_CREDENTIALS",
    );
  }
  return new ExternalServiceError("google", NETWORK_ERRORS.has(code) ? "unavailable" : "auth");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Ключ читается здесь, а не через keyFile: google-auth-library 11.3.1 с keyFile не заполняет iss в JWT,
// и Google отвечает invalid_grant «account not found».
async function createJwtClient(credentialsPath: string, fetch: typeof globalThis.fetch | undefined): Promise<JWT> {
  const key = serviceAccountKey.safeParse(parseJson(await readFile(credentialsPath, "utf8")));
  if (!key.success) {
    throw new OperationError(
      "Google Calendar: файл не похож на JSON-ключ сервисного аккаунта — проверьте GOOGLE_APPLICATION_CREDENTIALS",
    );
  }
  return new JWT({
    email: key.data.client_email,
    key: key.data.private_key,
    scopes: [SCOPE],
    ...(fetch ? { transporterOptions: { fetchImplementation: fetch } } : {}),
  });
}

function serviceAccountToken(options: GoogleCalendarOptions): () => Promise<string> {
  let client: JWT | undefined;
  return async () => {
    let token: string | null | undefined;
    try {
      client ??= await createJwtClient(options.credentialsPath, options.fetch);
      token = (await client.getAccessToken()).token;
    } catch (error) {
      const failure = tokenFailure(error);
      options.reportHealth?.("google", failure);
      throw failure;
    }
    if (!token) throw new ExternalServiceError("google", "auth");
    return token;
  };
}

function toResource(event: CalendarEvent) {
  return {
    id: event.eventId,
    status: "confirmed",
    summary: event.summary,
    description: event.description,
    start: { date: event.date },
    end: { date: addDays(event.date, 1) },
    transparency: "transparent",
    extendedProperties: { private: { app: PRODUCT_ID, premiereKey: event.premiereKey } },
  };
}

export type GoogleCalendar = CalendarPort & { readonly verifyAccess: () => Promise<void> };

/** Изменяет только события с меткой продукта; ID события задаёт приложение. */
export function createGoogleCalendar(options: GoogleCalendarOptions): GoogleCalendar {
  const http = createHttpClient({ ...options, service: "google" });
  const accessToken = options.getAccessToken ?? serviceAccountToken(options);
  const eventsUrl = `${options.baseUrl ?? BASE_URL}/calendars/${encodeURIComponent(options.calendarId)}/events`;
  const eventUrl = (eventId: string) => `${eventsUrl}/${encodeURIComponent(eventId)}`;

  const request = async (url: string, init: Parameters<typeof http>[1] = {}) =>
    http(url, { ...init, headers: { authorization: `Bearer ${await accessToken()}` } });

  /** `null` — события нет; чужое событие с тем же ID не изменяется. */
  async function readOwned(eventId: string, premiereKey?: string) {
    const response = await request(eventUrl(eventId), { accept: [404, 410] });
    if (response.status === 404 || response.status === 410) return null;
    const parsed = storedEvent.safeParse(response.body);
    if (!parsed.success) throw new ExternalServiceError("google", "invalid_response", response.status);
    const marks = parsed.data.extendedProperties?.private ?? {};
    const owned = marks.app === PRODUCT_ID && (premiereKey === undefined || marks.premiereKey === premiereKey);
    if (!owned)
      throw new OperationError(`Google Calendar: событие ${eventId} создано не Series Scout, оно не изменяется`);
    return parsed.data;
  }

  async function put(event: CalendarEvent) {
    await request(eventUrl(event.eventId), { method: "PUT", body: toResource(event) });
  }

  return {
    async createEvent(event) {
      const response = await request(eventsUrl, { method: "POST", body: toResource(event), accept: [409] });
      if (response.status !== 409) return;
      // ID уже занят: это результат прежней попытки (возможно, удалённый вручную) — приводим его к нужному виду.
      if ((await readOwned(event.eventId, event.premiereKey)) === null) {
        throw new ExternalServiceError("google", "rejected", 409);
      }
      await put(event);
    },

    async updateEvent(event) {
      if ((await readOwned(event.eventId, event.premiereKey)) === null) return "missing";
      await put(event);
      return "updated";
    },

    async deleteEvent(eventId) {
      const existing = await readOwned(eventId);
      if (existing === null || existing.status === "cancelled") return;
      await request(eventUrl(eventId), { method: "DELETE", accept: [404, 410] });
    },

    async verifyAccess() {
      await request(`${eventsUrl}?maxResults=1`);
    },
  };
}
