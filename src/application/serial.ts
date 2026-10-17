export type Serial = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/** Операции с одним ключом выполняются строго друг за другом; ошибка одной не блокирует следующие. */
export function createSerial(): Serial {
  const tails = new Map<string, Promise<unknown>>();
  return async (key, work) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
