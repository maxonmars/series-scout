import { ExternalServiceError, type FailureKind, type ServiceName } from "../application/errors.ts";

export type ReportHealth = (service: ServiceName, error: Error | null) => void;
export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type HttpClientOptions = {
  readonly service: ServiceName;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Всего попыток для временных ошибок: сеть, тайм-аут, 429 и 5xx. */
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
  readonly sleep?: Sleep;
  readonly reportHealth?: ReportHealth;
};

export type HttpResponse = { readonly status: number; readonly body: unknown };

type RequestOptions = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Статусы ошибок, которые вызывающий разбирает сам, например 409 при создании события. */
  readonly accept?: readonly number[];
};

function failureForStatus(status: number): FailureKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "rejected";
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export type HttpClient = (url: string, options?: RequestOptions) => Promise<HttpResponse>;

/** JSON-запросы с ограниченными повторами. `not_found` не считается сбоем сервиса. */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  const wait = options.sleep ?? sleep;

  const fail = (kind: FailureKind, status?: number): never => {
    const error = new ExternalServiceError(options.service, kind, status);
    if (kind !== "not_found") options.reportHealth?.(options.service, error);
    throw error;
  };

  return async (url, request = {}) => {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      const backoffMs = Math.min(maxRetryDelayMs, 1000 * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await doFetch(url, {
          method: request.method ?? "GET",
          headers: {
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
            ...request.headers,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const kind = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unavailable";
        if (last) return fail(kind);
        await wait(backoffMs);
        continue;
      }

      if (!response.ok && !request.accept?.includes(response.status)) {
        await response.body?.cancel();
        const kind = failureForStatus(response.status);
        if ((kind === "rate_limit" || kind === "unavailable") && !last) {
          const delay = retryAfterMs(response.headers.get("retry-after"), Date.now()) ?? backoffMs;
          await wait(Math.min(delay, maxRetryDelayMs));
          continue;
        }
        if (kind === "not_found") options.reportHealth?.(options.service, null);
        return fail(kind, response.status);
      }

      const raw = await response.text();
      let body: unknown = null;
      if (raw.trim() !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          return fail("invalid_response", response.status);
        }
      }
      options.reportHealth?.(options.service, null);
      return { status: response.status, body };
    }
  };
}
