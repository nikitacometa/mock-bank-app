# Cometa — handoff

Дата среза: 2026-09-04. Владелец поставил разработку на паузу после успешного acceptance.
Рабочее дерево намеренно не закоммичено. Перед продолжением читать `CLAUDE.md`, затем этот файл;
архитектурный канон остаётся в `docs/spec.md`, порядок возврата и product forks — в
`docs/next-phase.md`.

## Текущий результат

Web SPA готова как polished mock-neobank и работает на `https://euphoria.bot`. В приложении ровно
четыре demo-счёта: KZT current, KZT savings, USD и EUR. Закрытый currency domain поддерживает KZT,
THB, VND, RUB, USD, EUR, IDR и GEL; primary currency меняет portfolio total, но не валюты счетов.
Home отдельно показывает USD-equivalent активного не-USD счёта. RU/EN переключают весь interface,
money/date/input formatting и сохраняются раздельно для web и Telegram storage.

Ledger, integer minor units, frozen FX snapshots, UTC-day interest, Web Lock rebase,
idempotent transfers и platform seam сохранены. Persistence schema — `4`; schema `3` намеренно
reseed'ится, чтобы старый generic demo не пережил импорт выписки.

## Owner statement demo

`src/domain/statementData.ts` содержит 369 обезличенных строк из owner-provided statement за
2025-12-19…2026-06-30. Сохранены точные KZT-даты и суммы, включая 298 purchases с net
`−5 262 141,77 ₸`. Opening balance — `21 313 421,88 ₸`, напечатанный closing balance —
`11 100 519,26 ₸`.

В исходной PDF opening + все детальные строки дают `11 095 948,00 ₸`, то есть документ сам
расходится с printed close на `4 571,26 ₸`. Seed добавляет нейтральную скрытую из обычной History
ledger-строку `Сверка итогового баланса`; она не называет неизвестную причину расхождения. Операция
ChatGPT от 2026-06-19 перенесена с явным `pending` badge.

После выписки `seed.ts` детерминированно создаёт похожую активность до 2026-09-02: ChatGPT,
Spotify, GoPay, Yandex, Suka Kopi, Kagemusha, Outpost, Pepito, Qazaq Energy, Booking и car rental.
На portfolio allocation уходит `9 900 000 ₸` в savings, `369 816 ₸` в USD (`$800`) и
`214 743,69 ₸` в EUR (`€400`); остаток остаётся spending balance. Проценты материализуются ledger
строками и поэтому растут по календарным UTC-дням.

PII boundary: tracked fixture не содержит ФИО владельца, ИИН, реальных account/card/statement
identifiers, P2P-контрагентов или booking references; source PDF не копировалась в repo. Но точные
обезличенные dates + merchants + amounts находятся в public JavaScript bundle и остаются
fingerprintable. Для публичного шаринга вне личного demo нужен отдельный shifted/synthetic fixture.

## Merchant presentation

`src/ui/MerchantAvatar.tsx` содержит локальные custom vector marks для 18 узнаваемых merchants:
ChatGPT, Spotify, Yandex Go/Eats, Airbnb, Booking, GoPay, Gojek, Apple, AirAsia, Scoot, 12Go,
7-Eleven, Grab, Lazada, Tokopedia, Uniqlo и Qazaq Energy. Network favicons не используются;
неизвестные merchants получают category fallback. Арт декоративный и исключён из accessibility tree.

History откладывает текстовый filter через `useDeferredValue`, монтирует первые 24 date groups и
добавляет по 16 через локализованную кнопку. Memoized transaction rows не перерисовываются без
изменения props. Это оставляет полный ledger доступным, но не заставляет mobile WebView сразу
строить несколько сотен строк DOM.

## Telegram Mini App и bot

Frontend использует maintained `@tma.js/sdk-react` `3.0.23`. `adapter.telegram.ts` держит theme,
ready/viewport, haptics, MainButton и BackButton за `PlatformAdapter`; экраны Telegram не знают.
Raw `initData` уходит только в `POST /api/tma/bootstrap`. Backend проверяет Telegram HMAC,
duplicate keys, future skew и freshness, затем возвращает versioned RU/EN/currency/name preferences.
Bank accounts, cards, ledger, amounts и rates на backend не отправляются.

TMA persistence больше не использует общий origin-wide singleton: bank state, locale и bootstrap
receipt лежат в namespace canonical Telegram ID. До ответа HMAC-verified bootstrap приложение
переходит в неперсистентный quarantine, поэтому missing/malformed SDK identity не показывает и не
перезаписывает snapshot прошлого аккаунта. Storage events фильтруются по активному namespace;
same-ID mutation после failed write остаётся authoritative in-memory и повторно сохраняется.
Rejected Web Lock после смены аккаунта abort'ит stale mutation вместо fallback в новый namespace.

`bot/` — dependency-free Node 22 worker с SQLite, RU/EN onboarding, выбором восьми currencies,
optional display name, `/start`, `/settings`, `/help`, `/privacy`, menu button и profile setup.
Exact processed-update window durable; lower random Telegram update ID не отбрасывается только из-за
старого high watermark, а после шести суток без update sequence polling offset сбрасывается. Startup
profile calls идут последовательно; transient network/429/5xx failures повторяются с bounded
exponential backoff и Telegram `retry_after`, а permanent 4xx fail closed. Custom-name preference и
pending summary фиксируются одной SQLite transaction; outbox ретраит строки независимо после
успешного poll и не влияет на readiness. Один `AbortSignal` отменяет handler, Bot API request и retry
sleep при shutdown. Старая inline-кнопка языка не может вернуть уже законченный onboarding к выбору
валюты. Docker service non-root/read-only/cap-drop; token читается только из bind-mounted `0600` file.

Bootstrap ограничен rolling budget: 12 attempt starts за 5 минут; online/visibility signals имеют
30-секундный cooldown и coalesce in-flight retry. Splash не отпускает UI до identity isolation;
stale fulfilled attempt после timeout не может перезаписать fallback state.

Bootstrap response включает persisted lowercase 128-bit `revisionEpoch`. Telegram receipt schema v2
связывает canonical user, epoch, revision и BankState schema: новый server DB epoch применяется даже
при меньшем revision. Обычный image rollback использует тот же live DB и epoch. При ручном restore
старого SQLite snapshot оператор обязан сменить epoch, иначе клиент не может отличить restore от
устаревшего ответа.

Bot активирован на Irena. По явному решению владельца ранее опубликованный в chat token временно
установлен только для тестового запуска: hidden-TTY installer подтвердил через `getMe` точный
`@MyBankApp_Bot`, сохранил token как regular file с owner `10001:10001` и mode `0600`, затем локальный
clipboard был очищен. Значение не попало в argv, repo, docs, memory или command output. Это осознанный
security debt: перед любым нетестовым или публичным использованием token всё равно нужно revoke/rotate.
Startup закончил profile setup и polling: в логах есть `bot_http_listening` и `bot_polling_ready`,
ошибок setup/polling и container restarts нет.

`install-secret.sh` проверяет candidate через `getMe` именно для `@MyBankApp_Bot`, не кладёт token
в argv/logs и атомарно меняет live file. Standalone activation использует release-labelled images,
immutable image-ID manifest, общий deploy/renewal `flock`, 31-секундное stable-health окно и
проверенный rollback. Старый Hostinger activator оставлен только как legacy path; его readiness budget
синхронизирован с 150-секундным setup deadline, первым 25-секундным long poll и 65-секундным запасом.

BotFather Main Mini App и Menu Button enabled для `https://euphoria.bot/`; bot photo,
description/About и default Web App menu проверены. Бот также синхронизирует локализованный menu
button для пользователя после `/start`. Реальный Telegram Old на macOS открыл Main App в двух
профилях, передал два разных подписанных Telegram identity и отрисовал соответствующие имена без
утечки состояния между namespace. Home, History, Cards, native BackButton, pending ChatGPT filter и
чистый повторный запуск после полного restart Telegram прошли; четыре demo-счёта и 437 demo-операций
остались на месте. Полный RU/EN callback-onboarding и текущие Android/iOS clients остаются отдельным
acceptance gate.

## Deploy

Production migration target — выделенный VPS Irena (`ssh irena`, `187.53.132.226`), runtime root
`/srv/cometa-bank`. Hostname, key-only SSH, non-root `metaflexer` с passwordless sudo, Docker Engine +
Compose, UFW `22/80/443` и unattended upgrades настроены. Login user намеренно не включён в
root-equivalent группу `docker`.

Standalone Compose публикует только Nginx `80/443`. Web подключён к `public` + internal `edge`, bot —
к internal `edge` + отдельному egress bridge без публичного порта. Release source и оба images
immutable; tags проверяются по root-only image-ID manifests. Один и тот же финальный source дважды
упакован как `20260902T233104Z` (C) и `20260902T233133Z` (D): оба архива независимо прошли полный
`pnpm verify`, а распакованные source trees совпадают byte-for-byte по 167 файлам. Archive SHA-256:
C `sha256:e63d6791349d047a9060df63d7d2babadfa985b9b0a2c460a5bb87b99f98b2aa`, D
`sha256:5677e84522312e17b0d9df951662b7c064c05d68d6644e9e9bb01ca6c171daa8`. Release D активен,
C — automatic previous; D→C→D rollback rehearsal прошёл на live stack. Web и bot healthy,
restart count `0`, Nginx работает в HTTPS mode, renewal timer enabled/active. Certificate renewal
сравнивает fingerprint реально отданного leaf с candidate и восстанавливает предыдущую lineage при
ошибке. Renewal entrypoint, worker и systemd units host-owned. Root-owned record привязывает worker
к immutable source release, поэтому он использует recorded Compose contract, а не откатываемый
`current`. Первый upgrade с legacy layout использует persistent systemd condition guard и timer-state
journal; interrupted migration возобновляется fail closed. App rollback сохраняет новый hardened
worker. Pending recovery, deterministic orphan и Docker container/volume metadata error блокируют
prepare/activate/rollback до проверенного `--recover-only`.

Authoritative DNS для apex и `www` переключён на Irena `187.53.132.226`, AAAA отсутствуют. SAN ACME
успешен: новый Let's Encrypt certificate покрывает оба имени и действует до 2026-12-01. Повторная
проверка authoritative/public DNS подтверждает Irena для обоих имён; старый Hostinger vhost всё ещё
остаётся TLS-valid external rollback origin до real-device acceptance. Hostinger live static release —
`20260902T113558Z`, rollback release — `20260902T110137Z`; старый vhost остаётся noindex и без HSTS.

Старый Hostinger CPU-steal gate больше не блокирует bot: весь новый stack собран на Irena. Shared
Hostinger proxy и соседние services не менялись и не будут выключены до внешнего HTTPS smoke и
Telegram Android/iOS acceptance.

## Verification evidence

- `pnpm verify`: lint, CSS guards, web tests, bot tests, TypeScript и production builds зелёные.
- Latest full count: 36 web test files / 374 tests; 8 bot files / 102 tests.
- `pnpm audit --prod`: known vulnerabilities не найдены.
- Named mutants убиты для statement close, schema v3 reseed, seeded FX chronology в UTC−11/UTC+14,
  pending propagation, persisted status validation, Qazaq Energy matcher, sequential bot setup,
  Telegram `retry_after`, completed/custom-name onboarding preservation, per-ID persistence/
  quarantine, rejected-lock namespace switch, same-ID dirty recovery, initial persistence rejection
  containment, standalone renewal signal/crash recovery, host-worker rollback, History focus и
  monotonic live-region announcement.
- Live Playwright: 390×844 и 320×700 без document/body overflow; ровно 4 account buttons; schema v4;
  437 transactions; History window 24→40 groups; ChatGPT filter даёт 9 rows и 1 pending; RU/EN и
  восемь primary currencies; insufficient-funds CTA disabled без ledger mutation; clean console;
  Frankfurter запрос вернул `200`. TMA emulator применил signed-response shape `Ari Example / en / GEL`, сохранил
  user-bound schema-v4 receipt и отправил `web_app_ready`.
- Computer View повторно прошёл Home, History и pending ChatGPT filter в Chrome; визуальный drift не
  найден. Post-statement Claude Opus 5 xhigh passes нашли параллельный startup setup, eager History,
  stale-language rewind и два follow-up edge case: `custom_name` rewind и потерю focus на последней
  History page. Все механизмы исправлены и покрыты тестами. Спорный P2 про исключение `signature` из
  bot-token HMAC отклонён по current official Telegram protocol: HMAC исключает только `hash`, тогда
  как third-party Ed25519 исключает оба поля. Финальный immutable repeat `f7678b79` прошёл на
  Claude Opus 5 xhigh по 147 changed files с verdict `clean` и нулём findings.
- Irena preflight подтвердил key-only SSH, точный UFW allowlist, отсутствие лишних public TCP
  listeners, Docker/Compose versions и rendered Compose boundary. Prepared container healthy,
  read-only, cap-drop/no-new-privileges; local и container production assets имеют одинаковые hashes.
  Повторный `prepare` переиспользовал immutable web/bot image IDs; host entrypoint и оба systemd unit
  совпадают с release byte-for-byte, timer до activation disabled, root account locked.
- Новый Claude Opus 5 xhigh review standalone milestone (`77c7d738-0b44-4a26-a144-c4db916e51ee`)
  проверил 161 changed file и нашёл два P2 + два P3 в legacy activator/guards/onboarding. Все четыре
  механизма исправлены; отдельный VPS security pass нашёл first-install systemd verify и три recovery
  gaps, которые закрыты candidate-unit verification, host-owned unit semantics, checked runtime
  recovery и served-certificate fingerprint equality. Power-loss consistency пары release symlinks
  остаётся документированным low-probability residual risk; скрипт сериализован, но filesystem и
  Docker runtime не образуют общую транзакцию.
- Resilience Opus 5 xhigh pass 2026-09-03 нашёл три конкретных механизма: outbox drain блокировал
  первый poll/health, menu `retry_after` переживал shutdown grace, а legacy Hostinger renewal
  перезагружал shared proxy до semantic certificate validation. Все три подтверждены и исправлены.
  Follow-up добавил per-row outbox backoff, end-to-end AbortSignal, `/privacy`, materialized SQLite
  migration contract и legacy rollback/restart/trust harness. Следующий adversarial pass нашёл
  origin-wide TMA storage и rollback-coupled renewal worker; per-ID quarantine/namespaces и
  recorded host worker с crash-safe migration закрыли механизмы. Focused independent repeat clean;
  финальный full-diff Opus pass нашёл module-scope `AbortError`; после исправления exact post-fix
  repeat завершился verdict `clean`, 0 findings. Последующий двухстрочный numeric-UID portability fix отдельно
  проверен независимым reviewer и на реальном Irena host.
- Irena activation записала парные `activation-ready`/`activate` events в `deployments.jsonl`.
  Direct-origin TLS: apex `200`, HTTP/HTTPS `www` canonical redirects, SAN/key/trust valid; unauthenticated
  bootstrap возвращает `401 {"error":"invalid_init_data"}`. Оба containers read-only, cap-drop `ALL`,
  no-new-privileges; bot не имеет host ports. Public Telegram profile показывает `Cometa` и
  `Personal multi-currency demo bank`. Production Playwright через pinned Irena origin прошёл RU/EN,
  390×844 + 320×700, History/ChatGPT pending, USD equivalent, clean console и zero overflow.
- Первый post-review activation не переключил live release: Ubuntu 26.04 `uutils install` отверг
  numeric owner `10001`. Secret copy теперь создаётся root-owned с `0600`, затем получает numeric
  owner через `chown +10001:+10001`; deploy guard и target-host probe фиксируют этот контракт.
  Fresh C/D activation после исправления и D→C→D rehearsal прошли, token и demo data не потеряны.
- Реальный `cometa-bank-cert-renew.service` завершился `status=0/SUCCESS`; в журнале есть
  `certificate renewal, guarded reload, and served-SNI probes passed`. После него нет pending
  recovery, journal guard или orphan Certbot state. Публичный apex отвечает `200`, оба A-record
  указывают на Irena, TLS verify return code `0`, unsigned bootstrap fail closed с `401`.

## Открытые gates

1. Закончить реальный `@MyBankApp_Bot` callback-onboarding в двух test profiles: RU/KZT/Telegram name
   и EN/GEL/custom name, затем `/privacy`, повторный `/start`, localized menu app и bootstrap. Launch,
   signed bootstrap, identity isolation и History уже прошли; сообщения/callbacks требуют отдельного
   action-time подтверждения владельца.
2. Пройти Android/iOS Telegram WebView acceptance; desktop/browser emulation его не заменяет. Только
   после этого можно выводить Hostinger origin из эксплуатации и обсуждать HSTS.
3. До любого нетестового/публичного использования revoke/rotate установленный exposed test token и
   поставить замену через hidden-TTY `release.sh install-token`.
4. Legacy Hostinger renewal source теперь валидирует/откатывает certificate set до reload, но в этом
   цикле не установлен. Если Hostinger останется rollback origin дольше текущего acceptance окна,
   установить renewal patch либо вывести origin до истечения его certificate.

## Pause checkpoint

Intentional demo fixture из четырёх счетов и 437 операций сохраняется как baseline следующей
сессии. KBT-010 и остальные gates отложены владельцем, а не закрыты. Первый шаг при возвращении —
переснять Irena/DNS/TLS health, затем `pnpm verify`; точная очередность и идеи следующей продуктовой
фазы записаны в `docs/next-phase.md`.

Полный source milestone, English product README, showcase из реальных app screenshots и CI сохранены
в private GitHub repo `nikitacometa/mock-bank-app`; локальный `main` отслеживает `origin/main`.
Репозиторий нельзя делать public без замены fingerprintable statement fixture на shifted/synthetic
dataset и отдельного disclosure review operational docs.
