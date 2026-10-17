import { type DoctorInput, runDoctor } from "./doctor.ts";
import { createLogger } from "./logger.ts";
import { type NetworkProbe, networkProbes, runNetworkCheck } from "./network-check.ts";
import { runService } from "./run.ts";
import { type AppConfig, readConfig, secretValues } from "./settings.ts";

export type CliOutput = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

export type CliContext = DoctorInput & {
  readonly output: CliOutput;
  readonly onShutdown: (handler: () => void) => void;
  /** Подмена сетевых проверок в тестах. */
  readonly networkProbes?: (config: AppConfig) => readonly NetworkProbe[];
};

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const HELP = `Series Scout — персональный Telegram-бот для выбора сериалов и отслеживания премьер новых сезонов.

Использование:
  npm run dev -- [команда]    из исходников
  npm start -- [команда]      собранное приложение

Команды:
  help, --help, -h    эта справка
  doctor              локальная диагностика: версия Node.js и настройки, без сетевых запросов
  doctor --network    то же и проверка подключений: Telegram, TMDB, DeepSeek и модель, Google Calendar
  run                 запуск бота и фоновых проверок до сигнала остановки
`;

async function doctor(network: boolean, context: CliContext): Promise<number> {
  const report = runDoctor(context, { network });
  context.output.out(report.text);
  if (!network) return report.ok ? EXIT_OK : EXIT_FAILURE;
  const config = readConfig(context.env, context.inspectPath);
  if (!report.ok || !config.ok) {
    context.output.out("\nПроверка подключений пропущена: сначала исправьте настройки.\n");
    return EXIT_FAILURE;
  }
  const probes = (context.networkProbes ?? networkProbes)(config.config);
  const checked = await runNetworkCheck(probes);
  context.output.out(`\n${checked.text}`);
  return checked.ok ? EXIT_OK : EXIT_FAILURE;
}

async function run(context: CliContext): Promise<number> {
  const config = readConfig(context.env, context.inspectPath);
  if (!config.ok) {
    context.output.err(
      `Запуск невозможен: настройки не заданы или некорректны.\n${config.problems.map((problem) => `  ✗ ${problem}`).join("\n")}\nДиагностика: doctor. Образец настроек — .env.example.\n`,
    );
    return EXIT_FAILURE;
  }
  const logger = createLogger(context.output.out, secretValues(context.env));
  return runService({ config: config.config, logger, onShutdown: context.onShutdown });
}

export async function runCli(args: readonly string[], context: CliContext): Promise<number> {
  const [command, ...rest] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    context.output.out(HELP);
    return EXIT_OK;
  }

  if (command === "doctor") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--network")) {
      context.output.err(`Команда doctor принимает только --network. Справка: --help\n`);
      return EXIT_USAGE;
    }
    return doctor(rest[0] === "--network", context);
  }

  if (command === "run") {
    if (rest.length > 0) {
      context.output.err(`Команда run не принимает аргументов. Справка: --help\n`);
      return EXIT_USAGE;
    }
    return run(context);
  }

  context.output.err(`Неизвестная команда: ${command}. Справка: --help\n`);
  return EXIT_USAGE;
}
