import { existsSync } from "node:fs";
import { runCli } from "./cli.ts";
import { inspectPath } from "./inspect-path.ts";

// Без обработчика закрытый читатель (`| head`) роняет процесс с необработанным EPIPE.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

// Переменные, уже заданные в окружении, process.loadEnvFile не перезаписывает.
if (existsSync(".env")) process.loadEnvFile(".env");

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  nodeVersion: process.versions.node,
  inspectPath,
  output: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  onShutdown: (handler) => {
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  },
});
