export type ServiceName = "tmdb" | "deepseek" | "google" | "telegram";

export type FailureKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "invalid_response"
  | "empty_response";

/** Отказ внешнего сервиса. Текст ошибки не содержит ни тела ответа, ни настроек: только сервис и вид отказа. */
export class ExternalServiceError extends Error {
  readonly service: ServiceName;
  readonly kind: FailureKind;
  readonly status: number | undefined;

  constructor(service: ServiceName, kind: FailureKind, status?: number) {
    super(`${service}: ${kind}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "ExternalServiceError";
    this.service = service;
    this.kind = kind;
    this.status = status;
  }
}

/** Ответ модели прошёл схему, но нарушил контракт сценария: например, назвал сериал не из переданного списка. */
export class ModelContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelContractError";
  }
}

/** Ошибка сценария с готовым текстом причины для пользователя. */
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

const SERVICE_TITLES: Record<ServiceName, string> = {
  tmdb: "TMDB",
  deepseek: "DeepSeek",
  google: "Google Calendar",
  telegram: "Telegram",
};

const SETTINGS_HINT: Record<ServiceName, string> = {
  tmdb: "проверьте TMDB_READ_ACCESS_TOKEN",
  deepseek: "проверьте DEEPSEEK_API_KEY",
  google: "проверьте ключ сервисного аккаунта",
  telegram: "проверьте TELEGRAM_BOT_TOKEN",
};

function describeKind(error: ExternalServiceError): string {
  switch (error.kind) {
    case "auth":
      return `ключ отклонён — ${SETTINGS_HINT[error.service]}`;
    case "forbidden":
      return error.service === "google"
        ? "нет доступа к календарю — выдайте сервисному аккаунту право изменять события"
        : "доступ запрещён";
    case "not_found":
      return error.service === "google"
        ? "календарь не найден или не открыт сервисному аккаунту — проверьте GOOGLE_CALENDAR_ID и доступ"
        : "данные не найдены";
    case "rate_limit":
      return "превышен лимит запросов, повторите позже";
    case "timeout":
      return "сервис не ответил вовремя";
    case "unavailable":
      return "сервис недоступен";
    case "rejected":
      return `запрос отклонён${error.status === undefined ? "" : ` (HTTP ${error.status})`}`;
    case "invalid_response":
      return "ответ в неожиданном формате";
    case "empty_response":
      return "пустой ответ";
  }
}

/** Причина ошибки для пользователя и `/status`; секреты и тела ответов сюда не попадают. */
export function describeError(error: unknown): string {
  if (error instanceof ExternalServiceError) return `${SERVICE_TITLES[error.service]}: ${describeKind(error)}`;
  if (error instanceof ModelContractError) return `DeepSeek: ${error.message}`;
  if (error instanceof OperationError) return error.message;
  return "внутренняя ошибка приложения";
}

/** Для журнала: у внутренних ошибок дополнительно сообщение исключения. */
export function describeForLog(error: unknown): string {
  if (error instanceof ExternalServiceError || error instanceof ModelContractError || error instanceof OperationError) {
    return describeError(error);
  }
  return error instanceof Error ? `${describeError(error)}: ${error.name}: ${error.message}` : describeError(error);
}
