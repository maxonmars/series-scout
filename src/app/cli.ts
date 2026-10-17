import { type DoctorInput, runDoctor } from "./doctor.ts";

export type CliOutput = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

export type CliContext = DoctorInput & { readonly output: CliOutput };

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

Сейчас доступны только служебные команды: работа бота ещё не реализована.
`;

export function runCli(args: readonly string[], context: CliContext): number {
  const [command, ...rest] = args;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    context.output.out(HELP);
    return EXIT_OK;
  }

  if (command === "doctor") {
    if (rest.length > 0) {
      context.output.err(`Команда doctor не принимает аргументов. Справка: --help\n`);
      return EXIT_USAGE;
    }
    const report = runDoctor(context);
    context.output.out(report.text);
    return report.ok ? EXIT_OK : EXIT_FAILURE;
  }

  context.output.err(`Неизвестная команда: ${command}. Справка: --help\n`);
  return EXIT_USAGE;
}
