# Cometa — точка возврата и следующая фаза

Дата: 2026-09-04. Владелец поставил разработку на паузу после успешного web и Telegram Old
acceptance. Текущее production evidence и точные release identifiers находятся в
`docs/handoff.md`; архитектурный канон — в `docs/spec.md`.

## Замороженный baseline

- Сохранить intentional demo fixture: четыре счёта, 437 операций, owner-statement history,
  synthetic continuation и pending ChatGPT. Не reseed'ить и не заменять его без явного решения
  владельца.
- Ledger, cards и balances остаются client-only mock. Bot backend хранит только Telegram identity
  и onboarding preferences. Приложение не обрабатывает реальные деньги и не должно описываться как
  настоящий банк.
- Production origin — Irena; Hostinger остаётся TLS-valid external rollback origin. Julia к Cometa
  не относится.
- Полный source milestone защищён private remote `nikitacometa/mock-bank-app`; `main` отслеживает
  `origin/main`. Репозиторий остаётся private из-за fingerprintable statement fixture и operational
  deployment details.

## Порядок возобновления

1. Прочитать `CLAUDE.md`, `docs/handoff.md`, этот файл и `deploy/standalone/README.md`.
2. Переснять live-факты: Irena release status, containers/restarts, renewal timer, DNS apex/`www`,
   served TLS и публичный smoke. Старые значения из memory не считать текущими без проверки.
3. Проверить `git status`, синхронизировать `main` с `origin/main`, затем запустить `pnpm verify` и
   `git diff --check`.
4. Закрыть KBT-010: полный RU/KZT/Telegram-name и EN/GEL/custom-name callback onboarding,
   `/privacy`, повторный `/start`, localized menu и актуальные Android/iOS Telegram clients.
5. До public/non-test use перевыпустить тестовый bot token и установить замену только через hidden
   TTY. После mobile acceptance решить судьбу Hostinger, HSTS и legacy renewal patch.

## Решение перед новой продуктовой разработкой

Сначала выбрать один режим продукта:

1. **Личный polished mock.** Сохранить client ledger и вложиться в повседневный UX: budgets,
   recurring payments/subscriptions, merchant detail, category analytics, richer search и
   cross-device persistence через отдельный storage seam.
2. **Multi-user demo.** Спроектировать authentication, server-backed encrypted persistence,
   backup/restore, abuse limits и data deletion. Owner fixture заменить отдельным
   shifted/synthetic public dataset.
3. **Реальный financial product.** Это новый security/compliance проект: threat model, KYC/AML,
   authoritative server ledger, audit trail, payment rails и jurisdiction review должны появиться
   до UI-фич. Client-only mock ledger нельзя постепенно объявить real-money системой.

До выбора режима наиболее полезны наблюдаемость и сохранность: uptime/certificate alerts,
encrypted offsite SQLite backup и проверенный restore drill. Затем — cross-device persistence;
визуальные фичи уже не являются узким местом.

## Переносимые уроки

- Signed Telegram WebView и namespace isolation дали больше уверенности, чем browser emulation:
  identity нужно изолировать до чтения persistence, а не после bootstrap.
- Rollback доказывает переход `new → old → new` с проверкой persistent state и secret metadata,
  а не два независимых health-check.
- Recovery/renewal worker должен жить вне откатываемого `current` и ссылаться на immutable recorded
  source; незавершённый recovery обязан блокировать activate/rollback.
- Shell utility на target — часть runtime contract. Ubuntu 26.04 `uutils install` и GNU `install`
  различаются на numeric UID/GID; non-POSIX flags проверяются harmless probe на реальном host.
- Точные обезличенные даты, merchants и суммы всё равно fingerprintable в public bundle. Privacy
  boundary определяется распространяемым fixture, а не только отсутствием ФИО.
- Deterministic fixtures, failure-path tests и named mutants позволили полировать UX без разрушения
  money/ledger invariants. Demo dataset остаётся тестовым контрактом, а не расходником.
