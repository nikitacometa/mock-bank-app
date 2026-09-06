# Cometa — handoff

Дата среза: 2026-09-06. Multi-user Telegram ledger и новый Docker/Caddy perimeter реализованы в
локальном candidate, но ещё не deployed, не включены в live SQLite и не приняты в реальном bot
flow. Старый web/TMA baseline на Irena остаётся production. Последний полный integrated gate
предшествует финальным perimeter-изменениям; текущий snapshot ещё требует verify и immutable
repeat. Перед продолжением читать `CLAUDE.md`, затем этот файл; архитектурный канон остаётся в
`docs/spec.md`, порядок выпуска — в `docs/next-phase.md`.

## Текущий результат

Текущий live release остаётся polished mock-neobank на `https://euphoria.bot`: четыре demo-счёта
(KZT current, KZT savings, USD, EUR), device-local bank state и server bootstrap только для
Telegram preferences. Этот уже принятый baseline не изменён текущей работой.

Локальный candidate поднимает persistence до schema 5 и добавляет восемь deterministic fixtures:
`KZT`, `THB`, `VND`, `RUB`, `USD`, `EUR`, `IDR`, `GEL`. Fresh fixture всегда начинает с четырёх
role-accounts; KZT сохраняет owner history, остальные семь используют отдельные synthetic
country-specific ledgers с тем же pinned USD economics. Onboarding currency выбирает fixture один
раз; последующая primary currency меняет только reporting, а reset пересоздаёт тот же fixture.
Checking accounts можно добавлять и reversible close/restore. Home по-прежнему показывает
USD-equivalent активного не-USD счёта; RU/EN покрывают весь interface и formatting.

Ledger-derived balance, integer minor units, frozen FX snapshots, UTC-day interest, Web Lock
rebase, idempotent transfers и platform seam сохранены. Local candidate имеет explicit v4→v5
migration; production всё ещё исполняет старый schema-4 build.

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
В live baseline raw `initData` уходит только в `POST /api/tma/bootstrap`, а bank state остаётся на
device. Local authority candidate добавляет signed `bank-import`, `bank-command` и `bank-rates`:
backend проверяет Telegram HMAC, duplicate keys, future skew и freshness, сам выводит canonical ID и
после one-way activation хранит fictional `BankState` отдельно для него. TMA передаёт только typed
commands или refresh intent; provider rate payload клиентом не принимается.

TMA persistence больше не использует общий origin-wide singleton: bank state, locale и bootstrap
receipt лежат в namespace canonical Telegram ID. До ответа HMAC-verified bootstrap приложение
переходит в неперсистентный quarantine, поэтому missing/malformed SDK identity не показывает и не
перезаписывает snapshot прошлого аккаунта. Storage events фильтруются по активному namespace;
same-ID mutation после failed write остаётся authoritative in-memory и повторно сохраняется.
Rejected Web Lock после смены аккаунта abort'ит stale mutation вместо fallback в новый namespace.
Candidate также fingerprint'ит raw Telegram launch session: смена fingerprint открывает новый
identity epoch до чтения возможно stale parsed SDK user. Obsolete foreground sync не может вернуть
старый namespace. Обычный same-user sync сохраняет валидные screen/sheet/draft/toasts; каждая
canonical adoption закрывает только stale account/card/transfer target, а реальная смена namespace
полностью сбрасывает transient UI. Raw `initData` не сохраняется и не логируется.

`bot/` — dependency-free Node 22 worker с SQLite, RU/EN onboarding, выбором восьми currencies,
optional display name, `/start`, `/settings`, `/help`, `/privacy`, menu button и profile setup.
Local candidate добавляет `/add`, `/recurring`, `/accounts`, checking-only income/expense,
explicit UTC year/month/day backfill до 120 строк, no-overdraft, current savings adjustment и
reversible zero-balance close/restore. Следующий wizard session и предназначенный ему reply receipt
пишутся одной SQLite transaction. Delivery status и `update_processed` завершаются независимо:
pending processed receipt переживает pruning processed-ID window, delivered-before-processed
удаляется после acknowledgement, а delivered orphan хранится не дольше six-day sequence-reset
window.
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

Каждый response с canonical bank state фиксирует один exact UTC `serverTime`. Клиент проверяет его
относительно device clock только широким 24-hour sanity bound, но сам snapshot валидирует по server
time. Корректный response на секунду впереди телефона поэтому принимается; missing, non-canonical и
абсурдно удалённый timestamp отклоняются до adoption. Preferences-only и `import_required` payloads
state не несут и trusted time им не требуется.

Authority candidate принимает canonical state только после exact deep projection nested rates,
accounts, transactions/FX, cards, contacts, profile и recurring rules. Unknown nested keys не входят
в digest или SQLite. Stable JSON normalization сохраняет даже own `__proto__` keys и вложенные
варианты, поэтому разные operation payloads не могут сложиться в один hash. Future
account/closure/accrual, transaction/FX/contact и recurrence metadata,
неверная fixture topology и duplicate active checking currency отклоняются. User operation ledger —
sliding window на 8,192 Telegram/TMA rows. Exact replay работает, пока row retained; fresh command
в той же SQLite transaction вытесняет самую старую row без pending outbox, а rollback возвращает её
при любой ошибке replacement. Pending delivery не вытесняется; если защищены все rows, команда
получает typed `operation_capacity` до освобождения slot. Import и system materialization остаются
вне окна; `/bank-rates` имеет отдельный non-replayable budget. Mutation budget обходит только exact
operation, уже persisted в SQLite. Invalid, conflicting и crash-before-commit retries списывают его
снова.
Authenticated bootstrap ограничен 30 запросами на canonical Telegram ID в минуту: HMAC identity
уже проверена, но `ensureUser`/bank-state SQLite lookup ещё не начался; replay exemption нет.
`bank-import` так же сначала проверяет HMAC identity, затем списывает отдельный
`import_ingress` budget до чтения body. Для нового import более узкий import budget проверяется до
canonical hashing; только persisted operation с exact digest получает replay exemption.
`bank-command` симметрично списывает non-replayable `command_ingress` budget сразу после HMAC и до
чтения, parsing и canonical hashing body; persisted exact replay обходит только внутренний mutation
budget, но не ingress.

Canonical server materialization всегда выполняет `applySettleAll` перед recurring rules под
repository lock. Signed bootstrap и bot chat reads используют одну функцию. Повторный read в тот же
UTC-день не создаёт duplicate interest/occurrence rows и не поднимает revision без изменения state.
Если due materialization раздувает snapshot сверх 4 MiB, bootstrap возвращает последний canonical
snapshot без partial write. `reset_demo` намеренно обходит due materialization и остаётся доступным
recovery path; обычные команды, которые всё ещё превышают limit, получают typed
`413 bank_state_too_large`.
В History закрытый счёт остаётся selectable и сохраняет историю; его accessible name явно
добавляет localized `закрыт` / `closed`. Круглый marker остаётся визуальным и `aria-hidden`,
а active account labels не получают status suffix.
Пока ledger mode остаётся `local`, startup command profiles и `/help` показывают только
`/start`, `/settings`, `/help`, `/privacy`; mutation UX не рекламируется до authority switch.

Все перечисленные authority/wizard изменения пока только локальны. Live bot на Irena всё ещё
исполняет старый device-local bank contract; ни server ledger, ни новые chat flows там не включены.

Bot активирован на Irena. По явному решению владельца ранее опубликованный в chat token временно
установлен только для тестового запуска: hidden-TTY installer подтвердил через `getMe` точный
`@MyBankApp_Bot`, сохранил token как regular file с owner `10001:10001` и mode `0600`, затем локальный
clipboard был очищен. Значение не попало в argv, repo, docs, memory или command output. Это осознанный
security debt: перед любым нетестовым или публичным использованием token всё равно нужно revoke/rotate.
Startup закончил profile setup и polling: в логах есть `bot_http_listening` и `bot_polling_ready`,
ошибок setup/polling и container restarts нет.

`install-secret.sh` проверяет candidate через `getMe` именно для `@MyBankApp_Bot`, не кладёт token
в argv/logs и атомарно меняет live file. Standalone activation использует release-labelled images,
immutable image-ID manifest, serialized deploy `flock`, 31-секундное stable-health окно и
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

Read-only preflight 2026-09-06 зафиксировал фактическую топологию после reboot. Caddy `2.11.4`
enabled/active и единолично держит public TCP `80/443`. Web container публикует только
`127.0.0.1:8080→8080` и `127.0.0.1:8443→8443`; bot host ports не имеет. Caddy сохраняет исходный
Host и проксирует apex/`www` в полный Nginx HTTPS policy на loopback `8443` с соответствующим SNI.
Это временный compatibility hop: публичный certificate и ACME lifecycle принадлежат Caddy, а
внутренний Nginx certificate больше не является внешней trust boundary. Последний read-only audit
показал три ещё не применённых live gap: оба Cometa route используют `tls_insecure_skip_verify`,
Caddy слушает закрытый UFW порт `443/udp` из-за default HTTP/3, а legacy Nginx не восстанавливает
client IP до rate limit. Они закрыты в local candidate, но остаются live до подтверждённого
`harden-edge --apply`. Legacy
`cometa-bank-cert-renew.timer` disabled/inactive, service static/inactive. HSTS отсутствует.

Тот же read-only preflight подтвердил Docker Engine `29.7.2`, enabled/active
`docker.socket` на `/run/docker.sock`, daemon с единственным `-H fd://`, socket
`root:docker:0660` без non-root members и отсутствие `/etc/docker/daemon.json`. Это текущий
legacy-default runtime, а не новый verified contract: versioned daemon config и его recovery
installer на Irena ещё не запускались. Caddy admin пока остаётся на legacy
`127.0.0.1:2019`; permissioned Unix socket также ещё не применён.

Release `20260902T233133Z` (D) активен, `20260902T233104Z` (C) — automatic previous; web/bot healthy,
restart count `0`. Оба live `compose.yaml` были вручную изменены 2026-09-05 на loopback bindings:
они runtime-compatible с Caddy, но их release trees больше не immutable/source-clean. Старый
D→C→D rehearsal остаётся историческим evidence, а не доказательством нового source contract.
Live bot SQLite проходит `quick_check`, имеет `user_version=2`, не содержит bank authority tables,
operations или `ledger_mode`; production по-прежнему device-local.

Local deploy candidate устраняет drift в source: Compose фиксирует exact loopback `8080/8443`,
tracked Caddy contract описывает оба scoped host route без HSTS и trust bypass, а host preflight
требует `jq`, enabled/active Caddy, TCP-only `h1/h2`, закрытый UDP `443`, exact running Docker
bindings, trusted real-IP block и quiesced legacy renewal units. Перед ним отдельный
`install-docker-perimeter.sh` из immutable release A выполняет dry-run/apply, требует Docker 28+,
атомарно ставит canonical `/etc/docker/daemon.json` с `allow-direct-routing=false`,
`iptables=true`, `ip6tables=true`, фиксирует единственный daemon host `-H fd://` и pinned local
Unix-socket CLI, затем делает controlled restart только `docker.service`. Root-only durable journal
сохраняет source hash, original current, exact web/bot container IDs и restart counts, исходное
отсутствие config и фазу `install`/`rollback`. Exact `.pending.next` и
`daemon.json.cometa-bank.next` producer files можно продолжить или удалить только при однозначных
owner/mode/content; mixed или unknown state fail closed.

После Docker perimeter candidate-owned `harden-edge`
принимает только полностью legacy или fully hardened edge, validates оба next config до mutation,
target-scoped удаляет только два Cometa bypass и сохраняет unrelated Caddy route blocks, но применяет
общий `h1/h2` protocol policy ко всему Caddy. Он также ставит `persist_config off`, переносит admin
API с legacy TCP на caddy-owned Unix socket mode `0200`, reload'ит через endpoint, который реально
жив до перехода, и сравнивает canonical live config с installed Caddyfile. Он пересоздаёт только web
для нового bind-mounted Nginx inode. Recovery snapshots живут в root-only state вне process scratch и сохраняются, даже если
automatic restore тоже падает. Marker связывает operator/current release и SHA-256 обоих snapshots,
публикуется только после их directory flush и глобально блокирует другие lifecycle actions; повторный
apply из записанного operator release reconciles crash между atomic replace и reload, даже если web
не запущен. Compose source/runtime требуют exact service attachments и три Compose-owned bridge
network без `macvlan`/`ipvlan`, custom IPAM или extra attachment. Active
`prepare`/`activate`/`rollback`/`status`/`ledger-mode` делают отдельные inner `8443` и outer `443`
smokes, причём inner certificate проходит normal chain/hostname verification и 21-day expiry floor.
Они не вызывают certificate issuance, не устанавливают legacy renewal bundle и не включают Certbot
units. Installed Caddyfile проверяется семантически только для `euphoria.bot`, а не byte-for-byte.

Первый clean bridge требует два заранее упакованных и prepared identical-source release A/B.
Точный порядок: package/extract A/B → из A `install-docker-perimeter.sh` dry-run и `--apply` → из A
`release.sh harden-edge` dry-run и `--apply` → strict preflight A/B → prepare A/B → activate A/B при
ledger mode `local`. Пока A current, legacy D остаётся previous; если automatic recovery вернул D,
единственный canonical operator — immutable script A по
`/srv/cometa-bank/releases/<A>/.../release.sh`, а legacy D/C lifecycle запускать нельзя. После
успешного B обе стороны `current`/`previous` source-clean и обычный B→A→B rollback снова безопасен.

Local deploy candidate добавляет двухрелизный authority bridge и one-way
`release.sh ledger-mode server --apply`. `/app/<release-id>/` служит cache-key alias: любой
well-formed старый release path безопасно отдаёт current image при rollback, а точный запущенный
build доказывает compiled client-contract marker, не URL string. Если DB уже переключена в
`server`, но final audit/health flush упал, повторный `server --apply` пишет durable
`ledger-mode-server-reconciled` event и повторяет gates без ledger mutation. После durable final
event operator restart'ит current bot, startup публикует RU/EN server command profiles, затем
обязательны 31 continuous healthy seconds и TLS/API smoke. Reconciliation retry также restart'ит
bot; failure не откатывает authority. Этот путь ещё не выполнялся на Irena.

Switch создаёт WAL-safe root-only SQLite backup на том же host. Encrypted offsite backup, retention
monitoring и epoch-rotating restore drill явно отложены владельцем; до их реализации потеря Irena
может уничтожить server-side demo ledgers. Локальный backup не является disaster recovery.

Authoritative DNS для apex и `www` переключён на Irena `187.53.132.226`, AAAA отсутствуют. Caddy
отдаёт публичный Let's Encrypt certificate до 2026-12-04; retained inner Nginx certificate действует
до 2026-12-01, но проверка его chain/expiry на loopback hop намеренно отключена. Повторная проверка
authoritative/public DNS подтверждает Irena для обоих имён; старый Hostinger vhost всё ещё
остаётся TLS-valid external rollback origin до real-device acceptance. Hostinger live static release —
`20260902T113558Z`, rollback release — `20260902T110137Z`; старый vhost остаётся noindex и без HSTS.

Старый Hostinger CPU-steal gate больше не блокирует bot: весь новый stack собран на Irena. Shared
Hostinger proxy и соседние services не менялись и не будут выключены до внешнего HTTPS smoke и
Telegram Android/iOS acceptance.

## Verification evidence

### Local authority candidate

- Latest focused runs during implementation covered fixture/future-bound validation, deep
  projection, persisted-only replay exemption, wizard reply crash order, raw-session identity
  epochs, UI reconciliation and standalone ledger-mode recovery. An independent frontend preflight
  then closed the remaining P2 mechanisms: leaving History for Home, Cards or global transfer now
  synchronously normalizes a closed selection; manual transaction, custom-account and own-transfer
  user text keeps exact provenance across locale, search and replay; own-transfer rows use one
  O(n) counterpart-index build and O(1) lookup; synthetic fixture income is typed as semantic
  `topup`. Focused checks and named mutants for these paths are green.
- The last integrated gate before the final Docker/Caddy perimeter additions was green: 536 web
  tests and 215 bot tests, plus lint, CSS guards, TypeScript, deploy/bundle guards and production
  builds. Its `pnpm audit --prod`, token-shaped secret scan and full-tree `git diff --check` were
  also green. These numbers are historical evidence, not a final claim for the current snapshot;
  the current harness, full verify, audit/secret/diff scans and immutable repeat are pending.
- Fresh-eyes deploy audit found four concrete staged-edge gaps after the first green guard: active
  commands did not inspect runtime Docker bindings, legacy activation recovery omitted the pinned
  operator warning, Caddy matching allowed extra routes/upstreams, and `status` skipped immutable
  manifests. All four are closed. `check:deploy` now rejects public runtime binds and extra Caddy
  upstreams, validates exact web/bot cardinality and ports, uses strict Host/TLS/no-HSTS semantics,
  prints the safe immutable operator path before legacy activation work, and verifies both manifests.
  The two named deploy mutants were restored from `cp` backups and the stable rerun is green.
- The closing capacity audit is also resolved. Interest settlement is an atomic all-account batch,
  exact-cap reads/reset stay available, and recurring rows cannot steal its deferred slots. A
  near-4 MiB bootstrap falls back only on typed state-capacity failure, reset bypasses due
  materialization, and ordinary oversized writes remain typed `413`. Every state response carries
  one canonical `serverTime`; clients validate the snapshot against it while treating device time
  only as a broad sanity check. Local
  card freeze now uses the domain transition, so a stale action cannot unfreeze a card whose account
  closed. The user-operation ledger slides by pruning only completed/no-outbox rows inside the same
  transaction; oversized snapshots map to `413 bank_state_too_large`. The request limiter tracks
  2,048 user identities with per-route buckets instead of treating each route as another user.
- A final domain audit found that local web transfers still called the lower-level transfer helper
  directly. At exactly 5,000 rows, a successful contact or own-account transfer could therefore
  persist an invalid 5,001/5,002-row snapshot. The local store now routes both through the same
  bounded `applyBankCommand` transition as server mode, returns localized `capacity` copy, and leaves
  state plus persistence untouched. The named regression mutant was killed and restored.
- Final immutable Claude Opus 5 xhigh pass `30e664a4-11d3-4834-9e35-d51e3f1cbffa` found one P2 and
  two P3 boundaries: production-wired local mode delegated launch cards into the inactive bank flow,
  resuming an already-active rule always reported an applied change, and the wizard stored a raw
  amount longer than the canonical 64-code-point command bound. Local mode now gates every bank-flow
  call, active resume is a true no-op, and both amount-entry paths store the same bounded normalized
  value used by preview and confirm. Production-wiring, no-op and padded-input regressions are green;
  both behavior mutants were killed and restored. A fresh immutable post-fix repeat remains pending.
- The next immutable Opus 5 xhigh pass `cbd2bf7d-e49d-4bee-a2b8-1479fa48ddde` found the same raw
  amount mismatch in account balance adjustment. That wizard now normalizes and bounds its target
  before both durable storage and preview; a padded-input regression reaches canonical confirmation,
  and its raw-storage mutant fails exactly that test before restoration. Another immutable repeat is
  pending on the corrected snapshot.
- A follow-up input-boundary sweep found that review callbacks reused one flow ID across edited
  drafts. Every transaction, account and recurring review now rotates to a fresh opaque ID, so a
  button can confirm only the exact review beside it. The stale-confirm mutant is killed. Account
  and recurring confirms also re-preview current canonical state before execution and return a
  visible dashboard recovery path on drift. A separate grouped-money regression proves that bot
  language changes already replace the wizard with a new dashboard and expire its old confirmation;
  the reported locale-reparse mechanism was rejected on that end-to-end evidence. Display-name chat
  validation now shares the canonical Unicode policy and rejects surrogate code points.
- The closing wizard-state review found three successful-but-stale confirmation paths that a plain
  domain-error re-preview did not cover. Account reviews now bind the displayed pre-command balance
  and status; recurring reviews bind the full rule, account status/balance, UTC day and transaction
  capacity; a changed snapshot rotates the callback and asks for a fresh choice. Exact Telegram
  operations already committed before a crash bypass those preconditions on retry, reach the
  service replay path, consume the old session and deliver the original durable outbox. Four focused
  regressions and their named snapshot/replay mutants are green.
- Immutable Opus 5 xhigh pass `b074ca7c-23c4-4b2d-a695-44de7aea93f6` covered all 116 candidate
  paths and found one P3: `Shell` called `settleNow` immediately after a server bootstrap that had
  already materialized the canonical ledger. The redundant signed command consumed a mutation
  budget token and durable replay-window row on every launch despite `applied:false`. Client
  preflight now mirrors the authoritative due conditions: a materialized bootstrap and later
  same-day mounts are no-ops, while overdue savings or active due recurrence after a first import or
  UTC rollover issue one signed command. Concurrent calls share one per-user request. Verified
  Telegram foreground sync invokes the same action, so bridge-local ledgers still settle after a
  day change; read-only mode stays fail-closed. Four named mutants cover bootstrap no-op, first-import
  settlement, single-flight rollover and foreground resumption.
- A residual crash-order audit reproduced one P3 after a process died between atomic wizard reply
  insertion and `markProcessed`: if Telegram no longer replayed that update, a newer reply collided
  with the one-pending-reply constraint. Resume now drains the singular pending reply for that user
  regardless of its processed bit before accepting newer input. The end-to-end restart regression
  preserves the later message, and restoring the old SQL filter kills that named test. The remaining
  measured residuals are non-blocking: bounded 50-row global outbox head-of-line delay, roughly
  0.6-second confirmation at the artificial 5,000-row ceiling, and an impractical six-day exact
  update-ID collision.
- Immutable Opus 5 xhigh pass `c6d51ebb-ebfd-4a83-aa59-dc068bbfb79f` covered all 117 candidate
  paths and found one P3 at the exact 5,000-row ceiling. A positive-interest settlement that could
  not fit was correctly rejected atomically by the server, but client due-state kept submitting a
  fresh impossible command on every mount/foreground and consumed ingress plus replay-window
  capacity. The client now runs the same pure bounded settlement preflight and suppresses only that
  impossible batch; due recurrence remains actionable when settlement is not the blocker. Its exact
  capacity regression and named guard mutant are green.
- A final staged-edge audit found three live migration gaps plus one test gap: legacy C/D collapse
  all clients into one rate-limit bucket behind Caddy, target upstream TLS was not authenticated,
  default HTTP/3 opened an unexposed UDP listener, and sequential HTTPS smoke could mask an early
  failed probe under Bash conditional semantics. The candidate adds the target-scoped transactional
  `harden-edge`, strict served-certificate/real-IP/TCP-only gates, explicit failure propagation and
  negative harnesses. Ten apply failure injections restore both configs; the smoke and expiry-gate
  mutants fail their named checks and are restored. The server remains unchanged pending deploy
  confirmation.
- A fresh independent release review then found six remaining P2/P3 mechanisms. `harden-edge` now
  verifies the current immutable image manifest before force-recreate; every TLS/HTTP probe has a
  bounded deadline; recovery originals survive process cleanup; source and runtime guards reject
  host/container network namespaces; strict host preflight handshakes both inner hostnames. The
  interrupted two-link finding applied symmetrically to activation and rollback, so both now flush a
  root-only intent, accept only before/between/complete link states, reconcile runtime/config/links,
  record a durable event and retire the marker. Dynamic harnesses cover both directions and the
  recovery-failure snapshot path; the host-network mutant fails its named guard and is restored.
- The delayed canonical-rate race test used fixed 10:00/11:00 timestamps against the wall clock and
  could become invalid before noon UTC. It now pins 12:00 UTC explicitly and passed 20 consecutive
  focused runs; production future-skew rejection was not weakened.
- A post-fix Playwright re-smoke reloaded the final code at 390×844 and 320×568, then navigated
  History→Home and History→Cards. Both screenshots were visually clean, root/body widths equalled
  their viewports, the console had 0 errors and 0 warnings, and both sessions were closed. The
  formal remaining gates are unchanged.
- A second fresh-session pass after Revision 9 covered Home, History search, Cards and Settings at
  390×844 and 320×568. RU switched to EN without reload and persisted after reload; root/body widths
  matched each viewport, the console had 0 errors and 0 warnings, and both screenshots were
  visually inspected before the sessions closed.
- Fresh local Playwright sessions on 2026-09-05 passed at 390×844 and 320×568. RU/EN switched
  without reload; Home, History, Cards, Settings, Transfer, receipt and reset flows passed. History
  found the ChatGPT recurring entries, and Frankfurter returned `200`. Document/body had no
  horizontal overflow, dialogs fit both viewports, and the console had 0 errors and 0 warnings.
  Captured screenshots were visually inspected and clean. QA made one internal KZT transfer for
  `1,00 ₸`, then reset the demo and confirmed the original fixture was restored.
- Final immutable post-fix paired-review repeat and live bridge/two-profile deploy acceptance are still
  pending. This browser evidence is not Telegram/TMA live acceptance.
- No candidate server or UI result below is a production claim until two bridge releases and the
  one-way authority switch complete.

### Last accepted live baseline (2026-09-02…04)

- Baseline `pnpm verify`, production builds and `pnpm audit --prod` were green before the current
  authority work began.
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
  тогда оставалась документированным residual risk; current candidate закрывает её durable
  activation/rollback intents и deterministic reconciliation.
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

1. Синхронизировать final deploy harness с Docker installer/Caddy admin contract, затем выполнить
   `pnpm verify`, production audit, secret/diff scans, named perimeter mutant и final immutable
   paired-review repeat. Product/browser snapshot раньше прошёл fresh local Playwright, но это не
   заменяет новый integrated gate. Последний independent edge series закрыл retry deadlock,
   cross-release markers, directory durability, Compose project
   identity, unsafe network modes/options, partial producer output, Docker < 28 localhost semantics,
   exposed bot ports, missing-bot recovery и unchecked rollback/operator slots. Dynamic failure
   harnesses и named removed-fsync mutant подтверждают guards; нужен immutable verdict по итоговому
   snapshot.
2. После отдельного deploy confirmation установить отсутствующий на Irena `jq`, загрузить оба
   source-clean bridge archive, из A прогнать `install-docker-perimeter.sh` dry-run и `--apply`.
   Applying form делает controlled restart `docker.service`, проверяет exact pre-existing app
   identities и либо завершает canonical fd-only local-socket config, либо durable rollback.
   Затем из A прогнать `harden-edge` dry-run и `--apply`, strict Caddy/loopback/renewal preflight и
   `prepare` A/B. Hardening меняет только два target route плюс global `h1/h2`, сохраняет unrelated
   Caddy route blocks, добавляет real-IP block в shared legacy Nginx и переводит Caddy admin на
   permissioned Unix socket mode `0200` с `persist_config off`. Reload использует текущий endpoint.
   Controlled Docker restart и host-wide Caddy protocol/admin changes явно входят в maintenance scope.
   После этого активировать A/B подряд при `ledgerMode=local`. Если A вернул legacy D, продолжать
   только pinned script A. После B подтвердить source-clean `current`/`previous`, открыть оба owner
   profiles через release cache-key URL и проверить markers.
3. Выполнить one-way `ledger-mode server --apply`, импортировать по одному canonical snapshot на
   профиль и пройти две изолированные RU/KZT и EN/GEL journeys: manual income/expense, recurrence
   с backfill/no-overdraft, add/adjust/close/restore и B→A→B continuity. Telegram сообщения и
   callbacks требуют отдельного action-time подтверждения владельца.
4. Только после live journeys снять три sanitized Telegram captures в одну строку README и повторить
   public TLS/API/Playwright plus full verification.
5. Пройти Android/iOS Telegram WebView acceptance; desktop/browser emulation его не заменяет. Только
   после этого можно выводить Hostinger origin из эксплуатации и обсуждать HSTS.
6. До любого нетестового/публичного использования revoke/rotate установленный exposed test token и
   поставить замену через hidden-TTY `release.sh install-token`.
7. После двух clean bridge releases отдельной задачей перевести Caddy на loopback HTTP, удалить
   redundant inner TLS/Certbot volume и legacy renewal code. До этого Caddy→Nginx `8443` остаётся
   осознанным compatibility hop; legacy renewal units должны оставаться quiesced.
8. Legacy Hostinger renewal source теперь валидирует/откатывает certificate set до reload, но в этом
   цикле не установлен. Если Hostinger останется rollback origin дольше текущего acceptance окна,
   установить renewal patch либо вывести origin до истечения его certificate.
9. Отдельной задачей добавить encrypted offsite SQLite backup, retention/alerts и проверенный
   epoch-rotating restore. До этого single-VPS loss остаётся принятым demo risk.

## Pause checkpoint

Intentional owner KZT fixture из четырёх счетов и 437 операций сохраняется без замены; ещё семь
synthetic fixtures добавлены рядом, а не поверх него. Новый candidate не принят и не deployed.
Первый шаг при возвращении — проверить worktree/review status, закончить final local gate, затем
переснять Irena/DNS/TLS/ledger-mode health; точная очередность записана в `docs/next-phase.md`.

Старый source milestone, English product README, showcase и CI опубликованы в public GitHub repo
`nikitacometa/mock-bank-app`; локальный `main` отслеживает `origin/main`. Owner явно выбрал public
visibility при сохранении fingerprintable KZT fixture. Новые три Telegram screenshots пока не
сняты: их нельзя подменять emulator/fake chrome до M8 acceptance.
