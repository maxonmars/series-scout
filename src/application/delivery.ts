import { describeError } from "./errors.ts";
import type { Clock, NotificationPort, OutboxStore } from "./ports.ts";
import type { Serial } from "./serial.ts";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

export type DeliveryDeps = {
  readonly outbox: OutboxStore;
  readonly notifications: NotificationPort;
  readonly clock: Clock;
  readonly serial: Serial;
};

export type DeliveryResult = { readonly sent: number; readonly error: string | null };

/** Отправляет очередь по порядку; на первой ошибке останавливается, чтобы не нарушить порядок сообщений. */
export function createDelivery({ outbox, notifications, clock, serial }: DeliveryDeps) {
  return {
    deliver(): Promise<DeliveryResult> {
      return serial("delivery", async () => {
        let sent = 0;
        for (const item of outbox.dueMessages(clock.now())) {
          try {
            await notifications.send(item.message);
          } catch (error) {
            const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** item.attempts);
            outbox.markFailed(item.id, describeError(error), clock.now() + delay);
            return { sent, error: describeError(error) };
          }
          outbox.markSent(item.id, clock.now());
          sent += 1;
        }
        return { sent, error: null };
      });
    },
  };
}

export type Delivery = ReturnType<typeof createDelivery>;
