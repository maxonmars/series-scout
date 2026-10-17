import { accessSync, constants, statSync } from "node:fs";
import type { PathState } from "./settings.ts";

/** Проверяет тип и доступность пути, не открывая файл: содержимое credentials не читается. */
export function inspectPath(path: string): PathState {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    return "inaccessible";
  }
  if (stats === undefined) return "missing";
  if (stats.isDirectory()) return "directory";
  if (!stats.isFile()) return "other";
  try {
    accessSync(path, constants.R_OK);
    return "readable-file";
  } catch {
    return "unreadable-file";
  }
}
