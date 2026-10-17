# Архитектура

Один npm-пакет на TypeScript (ESM), Node.js 24. Без workspaces и отдельных сервисов.

## Слои

| Каталог | Назначение |
| --- | --- |
| `src/app` | Точка входа: чтение `process.env`, `process.argv` и `.env`, композиция зависимостей, CLI. |
| `src/domain` | Предметные типы и правила. Чистый TypeScript. |
| `src/application` | Пользовательские сценарии и интерфейсы внешних зависимостей, которые нужны сценариям. |
| `src/adapters` | Реализации интерфейсов: Telegram (grammY), DeepSeek (`openai`), TMDB (`fetch`), Google Calendar (`fetch` + `google-auth-library`), SQLite (`node:sqlite`). |
| `src/prompts` | Markdown-инструкции для модели. |

Сейчас код есть только в `src/app`; остальные каталоги пусты (`.gitkeep`).

## Направления зависимостей

```
app ──► adapters ──► application ──► domain
 │                        ▲
 └────────────────────────┘
```

Правила в [.dependency-cruiser.cjs](.dependency-cruiser.cjs), проверка — `npm run check:deps`:

| Правило | Запрет |
| --- | --- |
| `domain-is-pure` | `domain` импортирует только `domain`: ни других слоёв, ни Node API, ни npm-пакетов. |
| `application-not-to-outer-layers` | `application` не импортирует `app` и `adapters`. |
| `application-not-to-integration-sdk` | Из npm-пакетов `application` может использовать только `zod`; `node:sqlite` запрещён. |
| `only-app-imports-app` | `app` — корень композиции, его никто не импортирует. |
| `no-dev-dependencies-in-src` | Production-код не импортирует dev-зависимости. |
| `no-circular` | Циклические зависимости. |
| `no-unresolvable` | Неразрешимые импорты. |

Импорты только типов тоже учитываются (`tsPreCompilationDeps`), поэтому типы SDK не просочатся в `domain` и `application` через `import type`.

Конфигурация передаётся явно: `process.env` и `process.argv` читает только `src/app/main.ts`, остальной код получает значения параметрами.

## Точки входа

- `src/app/main.ts` — загрузка `.env` через `process.loadEnvFile`, запуск `runCli` и установка кода завершения.
- `src/app/cli.ts` — разбор команды: `help`, `doctor`; остальное — ошибка использования (код 2).
- `src/app/doctor.ts` и `src/app/settings.ts` — описание настроек, проверка через Zod и формирование отчёта. Значения секретов в отчёт не попадают: показываются только значения, помеченные `public`.
- `src/app/inspect-path.ts` — проверка пути через `stat` и `access` без чтения файла.

Собранная точка входа — `dist/app/main.js`; её же запускает Docker-образ (`ENTRYPOINT`).

## Сборка

- Исходники запускаются Node.js 24 напрямую (type stripping). `erasableSyntaxOnly` запрещает синтаксис, который требует преобразования: `enum`, `namespace`, parameter properties.
- Импорты пишутся с расширением `.ts`; `rewriteRelativeImportExtensions` заменяет его на `.js` при сборке.
- `tsconfig.json` проверяет `src`, `tests` и `vitest.config.ts` без генерации файлов; `tsconfig.build.json` собирает только `src` в `dist`.
- `npm run build` после компиляции запускает `dist/app/main.js --help`, чтобы проверить собранный JavaScript, а не только исходники.
- TypeScript зафиксирован на 6.x: dependency-cruiser 18 поддерживает TypeScript `<7.0.0` — ему нужен классический JS API компилятора, которого нет в пакете TypeScript 7.

## Граница текущего этапа

Реализованы запуск, справка, конфигурация и локальная диагностика. Не реализованы: обработчики Telegram, интервью и рекомендации, клиенты интеграций, схема SQLite, подписки, синхронизация календаря, планировщик и промпты.

Docker-контейнер сейчас выполняет одну команду и завершается; долгоживущий процесс бота и планировщика появится вместе с Telegram-адаптером.
