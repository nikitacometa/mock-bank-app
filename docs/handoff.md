# Cometa — handoff

Дата среза: 2026-09-07; timestamps ниже — 2026-09-06 UTC. Current B `20260906T173602Z`, previous
A `20260906T173601Z`, оба source `ef9a960`. Оба prepared/activated и healthy: A в `17:45:07Z`,
B в `17:46:54Z`. CI `34049087351` прошёл 815 tests. Оба Old профиля реально переоткрыты через
Escape → main window Open Cometa, compiled `173602`, по 438 rows с прежними exact tx hashes.
Новая попытка server activation в `18:04Z` остановилась до switch/restart/import: WAL-fix прошёл,
но shell удалил SQL single quotes в embedded Node eval (`WHERE type = table`, syntax error).
Mode LOCAL, imports 0, web/bot healthy. Две runtime строки operator заменены bound parameters,
harness проверяет real Bash-parsed JS на scratch SQLite: focused/full 815 verify PASS, compiling
exact-SQL-quoting mutant killed.
Activation заблокирована до verified fix и нового immutable deploy; bank chat flows не включены.
Попытка `ledger-mode server --apply` в `14:37:32Z` остановилась до mode switch/restart: read-only
single-file WAL backup не может создать SQLite sidecars (code 14). Root `0600` backup сохранён:
`/srv/cometa-bank/backups/20260906T143732Z-before-ledger-mode-server.sqlite`, `quick_check=ok`, LOCAL.
Выпущенный `ef9a960` WAL-fix нормализует только disposable `.compat` в DELETE, не live DB/retained backup.
815 tests и compiling mutant red/restored green; exact read-only Docker probes на обоих existing
images прошли с normalized synthetic copy, original unchanged. Владелец явно разрешил текущий
WAL-fix без Opus; это отдельный narrow waiver, не перенос прежнего `774f0ae` exception.
Retry `/private/tmp/claude-paired-review-wal-backup-retry-20260906/attempt.md` не дал report и
остановлен оператором после 10 минут: не clean и не повторно подтверждённая org access error.
WAL-fix deployed в `173601`/`173602` без нового Opus attempt. Его gate пройден; последующий SQL
quoting defect блокирует server activation, последний проверенный mode LOCAL.
Final `pnpm verify` повторно прошёл 815 tests, lint/deploy guards/build в `13:01Z`.
Ранее combined Opus review recovery не выполнился из-за отключённого организацией Claude Code
access. Тогда владелец явно waived missing review только для emergency recovery
source `774f0ae`; это закрывает только его deploy gate, не означает clean review или общий waiver.
Предыдущие B `095602` activation и unhealthy rollback A `095601` из-за `setMyName 429` — история
incident, устранённого profile read-before-write и guarded recovery.
Candidate `2897de5` сохраняет предыдущие lifecycle/import исправления и закрывает terminal
cold-session guard из v19 с red/green compiling mutant. Полный `pnpm verify` прошёл: 799 tests,
577 web + 222 bot. Immutable real-browser pass прошёл 5 scenarios / 19 checks. Visual preference
v19 о continuous progress отклонён: Chrome подтвердил неизменные geometry/focus, поведение явно
зафиксировано в CLAUDE invariant. Это проверенный source pair неудачного deploy, не текущий healthy gate.
Первоначальный v20 не запустился из-за session quota; exact Opus 5 retry завершён в `10:18Z`:
verdict `clean`, 0 findings, resolved source `2897de5`.
В `10:05Z` повторно пройдены 9 signed checks; healthy checkpoint `10:08Z` предшествует bot incident.
Visuals опубликованы в `51a2eb0`. Последний Linux CI `ef9a960` green, run `34049087351` (815 tests);
это не proof server activation или review нового SQL quoting fix.
CLAUDE invariants ранее записаны в `ae9c65e`.
Новый milestone
ещё не принят.

Исторический gate deployed `5774b01`: 541 web + 222 bot tests, 10 local web-browser checks,
9 synthetic signed real-backend checks и clean narrow Opus v13. Эти results не заменяют review
candidate и повторный native pass после его deploy. Production isolated-browser pass также прошёл
10 checks. Перед продолжением читать `CLAUDE.md`,
затем этот файл; архитектурный канон остаётся в
`docs/spec.md`, порядок выпуска — в `docs/next-phase.md`.

## Текущий результат

На `https://euphoria.bot` web и bot healthy на B `173602`; server activation пока заблокирована.
Пока `ledger_mode=local`,
web и Telegram bank state остаются device-local; разрешённый bot profile содержит только
non-mutating commands. Existing
owner snapshots сохранены: Nikita — все 438 rows без изменения; MetaFlexer — 437→438 только за счёт
interest settlement. Это два проверяемых собственных Telegram Old профиля; их не следует
отождествлять с John Cometa по одному display name.

Оба оригинальных Old профиля Nikita и MetaFlexer реально прошли Escape → main window Open Cometa
через AX Main Menu/account switching: compiled `173602`, по 438 rows, прежние exact tx hashes.
Просьба manual reopen разрешена этим реальным pass. Ранее owner-waived remaining native
button/foreground scope не превращается в tested pass; остальные phone gates открыты.
По явной просьбе владельца открыт отдельный headed Chrome с fresh profile
`/private/tmp/cometa-telegram-web-qa.Mtuner/profile`; владелец вошёл через QR. Реальный Telegram Web
John Cometa прошёл English → KZT → Cometa is ready → Open Cometa → Telegram open-page consent →
embedded Mini App. Web namespace hash `b8c452f98d` отличается от Old Nikita `5a39b27c62` и MetaFlexer
`a98ab714e4`: не отождествлять эти namespace по display name. В Web compiled
`104102`, 437 rows, 4 accounts; reset/mutations не выполнялись. Browser plugin по-прежнему без
bindings; Playwright использует только отдельный owner-authorized profile. Focused John Web QA
пройден, включая foreground/reopen; Old final-build marker/parity gate пройден. Phone и server-mode
gates не закрыты; manual native button/foreground scope waived владельцем, не протестирован.
В `12:58Z` John Web: поиск ChatGPT дал 9 результатов, включая original Pending; Received filter —
0. RU→English и primary KZT→USD→KZT пройдены; currency меняла только total display. Точные hashes
437 transactions и accounts не изменились, marker `104102`. KZT transfer `700000` заблокирован
disabled Transfer с нехваткой `84040.43`; submit не выполнялся. Draft `123 KZT` сохранился после
переключения на отдельную about:blank tab и обратно; native MainButton `Transfer ₸123.00` enabled,
native Back закрыл sheet. Mini App закрыта, `/help` вернул четыре LOCAL commands, новая кнопка
Open Cometa снова открыла приложение. Финальный `bank-proof` в `13:03:48Z`: те же hashes,
437 rows/4 accounts, English, primary KZT, compiled `104102`, LOCAL. Submit/mutations не выполнялись.

Deployed bridge поднимает persistence до schema 5 и добавляет восемь deterministic fixtures:
`KZT`, `THB`, `VND`, `RUB`, `USD`, `EUR`, `IDR`, `GEL`. Fresh fixture всегда начинает с четырёх
role-accounts; KZT сохраняет owner history, остальные семь используют отдельные synthetic
country-specific ledgers с тем же pinned USD economics. Onboarding currency выбирает fixture один
раз; последующая primary currency меняет только reporting, а reset пересоздаёт тот же fixture.
Server-mode flows предусматривают add и reversible close/restore checking accounts; пока mode
local, эти bot-действия выключены. Home по-прежнему показывает
USD-equivalent активного не-USD счёта; RU/EN покрывают весь interface и formatting.

Ledger-derived balance, integer minor units, frozen FX snapshots, UTC-day interest, Web Lock
rebase, idempotent transfers и platform seam сохранены. Explicit v4→v5 migration работает в
deployed build; она не означает переход device-local данных под server authority.

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

Authority/wizard implementation теперь deployed в A/B, но пока выключен persisted `local` mode.
Ни server ledger, ни mutating chat flows ещё не включены; local-mode bridge не должен рекламировать
`/add`, `/recurring` и `/accounts` как доступные действия.

Bot активирован на Irena. По явному решению владельца ранее опубликованный в chat token временно
установлен только для тестового запуска: hidden-TTY installer подтвердил через `getMe` точный
`@MyBankApp_Bot`, сохранил token как regular file с owner `10001:10001` и mode `0600`, затем локальный
clipboard был очищен. Значение не попало в argv, repo, docs, memory или command output. Это осознанный
security debt: перед любым нетестовым или публичным использованием token всё равно нужно revoke/rotate.
После исторического `setMyName 429` incident recovery `104101`/`104102` восстановил profile setup
и polling: `bot_polling_ready`, zero restarts, повторных profile `429` нет.

`install-secret.sh` проверяет candidate через `getMe` именно для `@MyBankApp_Bot`, не кладёт token
в argv/logs и атомарно меняет live file. Standalone activation использует release-labelled images,
immutable image-ID manifest, serialized deploy `flock`, 31-секундное stable-health окно и
проверенный rollback. Старый Hostinger activator оставлен только как legacy path; его readiness budget
синхронизирован с 150-секундным setup deadline, первым 25-секундным long poll и 65-секундным запасом.

Отдельный deferred portability debt: `deploy/bot/install-secret.sh:146`, ветка `restorePrevious`,
вызывает `install -o 10001 -g 10001`. На Irena uutils `0.8.0` отвергает эти owner/group arguments,
поскольку NSS entries для `10001` отсутствуют. Нормальный installer path не затронут; текущий
token при bridge rollout не менялся. До следующей rotation исправить restore через root-owned
install + numeric `chown` и проверить восстановление на scratch-файле, не на live credential.

Historical baseline acceptance (2026-09-02…04): BotFather Main Mini App и Menu Button enabled для
`https://euphoria.bot/`; bot photo,
description/About и default Web App menu проверены. Бот также синхронизирует локализованный menu
button для пользователя после `/start`. Реальный Telegram Old на macOS открыл Main App в двух
профилях, передал два разных подписанных Telegram identity и отрисовал соответствующие имена без
утечки состояния между namespace. Home, History, Cards, native BackButton, pending ChatGPT filter и
чистый повторный запуск после полного restart Telegram прошли; четыре demo-счёта и 437 demo-операций
остались на месте. Полный RU/EN callback-onboarding и текущие Android/iOS clients остаются отдельным
acceptance gate.

## Deploy

Production migration target — выделенный VPS Irena (`ssh irena`, `187.53.132.226`), runtime root
`/srv/cometa-bank`. Hostname, key-only SSH, non-root `irena` с passwordless sudo (live source:
`ssh -G irena`, актуальный user `irena`, uid/gid `1001`, не прежний `metaflexer`), Docker Engine +
Compose, UFW `22/80/443` и unattended upgrades настроены. Login user намеренно не включён в
root-equivalent группу `docker`.

Verified rollout 2026-09-06 применил Docker perimeter в `07:15:41Z` и Caddy edge hardening в
`07:17:30Z`. Caddy `2.11.4` enabled/active и единолично держит public TCP `80/443`; protocols —
только `h1/h2`. Web публикует `127.0.0.1:8080→8080` и `127.0.0.1:8443→8443`, bot host ports
не имеет. Caddy сохраняет Host, проверяет certificate/SNI внутреннего `8443` hop, а Nginx
восстанавливает trusted client IP до rate limit. Admin API переехал с TCP `2019` на caddy-owned
Unix socket mode `0200`; `persist_config off` включён. Legacy
`cometa-bank-cert-renew.timer` disabled/inactive, service static/inactive; HSTS отсутствует.

Docker Engine `29.7.2` использует единственный `-H fd://`, systemd socket activation и локальный
`/run/docker.sock`; exact versioned `/etc/docker/daemon.json` установлен. Key-only SSH, UFW
`22/80/443`, loopback/runtime bindings и `jq 1.8.1` проверены. Controlled restart, strict perimeter,
31-second stable health и inner/outer TLS/API smoke прошли.

Оба source-clean release собраны из `5774b01`: A `20260906T071100Z` activated в `07:22:17Z`,
B `20260906T071101Z` — в `07:23:53Z`. Это историческая успешная bridge pair, не текущие release IDs:
позднее B `095602` activation не прошёл gate, automatic rollback A `095601` тоже unhealthy.
Перед A и B созданы root-only WAL-safe SQLite backups в `07:20:46Z` и `07:22:22Z` соответственно,
в `/srv/cometa-bank/backups` на том же VPS. Persisted `ledger_mode` остаётся `local`; импортов нет.
Старые C/D (`20260902T233104Z`/`20260902T233133Z`) и их вручную patched loopback source — только
исторический migration evidence, не текущие rollback slots. Новый B→A→B persistence rehearsal
ещё не принят и остаётся частью live authority QA.

Deployed release contract устраняет прежний drift: Compose фиксирует exact loopback `8080/8443`,
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

Первый clean bridge завершён. Выполненный порядок: package/extract A/B → из A
`install-docker-perimeter.sh` dry-run и `--apply` → из A
`release.sh harden-edge` dry-run и `--apply` → strict preflight A/B → prepare A/B → activate A/B при
ledger mode `local`. Обе стороны стали source-clean. После позднего `setMyName 429` incident
продолжать нужно по guarded recovery path, а не повторять host-wide migration или activation
неизменённого bot. Совместимость ранней pair проверена release gates; фактический B→A→B с owner
ledger changes ещё требует rehearsal.

Deployed code поддерживает двухрелизный authority bridge и one-way
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
до 2026-12-01; после hardening normal chain/hostname verification и expiry gate включены. Проверка
authoritative/public DNS подтверждает Irena для обоих имён; старый Hostinger vhost всё ещё
остаётся TLS-valid external rollback origin до real-device acceptance. Hostinger live static release —
`20260902T113558Z`, rollback release — `20260902T110137Z`; старый vhost остаётся noindex и без HSTS.

Старый Hostinger CPU-steal gate больше не блокирует bot: весь новый stack собран на Irena. Shared
Hostinger proxy и соседние services не менялись и не будут выключены до внешнего HTTPS smoke и
Telegram Android/iOS acceptance.

## Verification evidence

### Live bridge checkpoint (2026-09-06)

- Source `5774b01` прошёл consecutive A→B activation, strict Docker/Caddy perimeter,
  stable health и public/inner TLS/API smoke. Root-only WAL-safe backups созданы перед каждой
  activation; это same-host recovery, не offsite backup.
- Production isolated-browser suite прошёл 10 checks. Это дополнительный pass на live origin,
  отдельно от 10 local web и 9 synthetic signed real-backend checks ниже.
- Реальные Telegram Old profiles Nikita и MetaFlexer сохранили compiled marker B
  `20260906T071101Z`. Nikita сохранил все 438 существующих ledger rows без изменений; MetaFlexer
  получил ровно одну interest row поверх 437. John Cometa в этот pass не использовался;
  display names сами по себе не доказывают совпадения identities.
- MetaFlexer foreground/resume выявил lifecycle self-abort, оставляющий Mini App в `read_only`.
  Это историческая находка deployed source; исправления уже входят в candidate `2897de5`.
  Их локальные regression/mutant/full gates пройдены; v18 fixes сохранены, terminal finding v19
  исправлен, visual preference отклонён с browser evidence. После первоначальной quota failure
  exact Opus 5 v20 retry завершился в `10:18Z`: clean, 0 findings на `2897de5`.
  Нужны два
  новых source-identical releases и повтор foreground/reopen в обоих реальных профилях с проверкой
  сохранности данных. Clean review v13 не покрывает candidate.
- `ledger_mode=local`; server activation, canonical imports, live mutation journeys и новый
  B→A→B data-persistence rehearsal не выполнялись. Milestone и Android/iOS acceptance не закрыты.

### Local candidate checkpoint (2026-09-06, `2897de5`)

- Candidate `2897de5`: полный `pnpm verify` прошёл, 577 web + 222 bot = 799 tests, включая lint,
  CSS/deploy/bundle guards, typecheck и production builds. Immutable real-browser pass: 5 scenarios,
  19 checks, PASS; evidence — `/private/tmp/cometa-foreground-browser-2897de5-4ZzXID/report.json`.
  Terminal cold-session guard из v19 исправлен с red/green compiling mutant. Visual preference
  v19 о continuous-progress display отклонён: фактические Chrome geometry и focus неизменны,
  same-card поведение закреплено явным CLAUDE invariant.
- Все три confirmed findings завершённого v18 исправлены: та же карточка показывает truthful RU/EN
  pending copy во время progress/import; `aria-disabled` и click guard сохраняют focus и доступное
  announcement; SDK, впервые появившийся на 15-й секунде после исчерпанной ladder, обнаруживается
  на 16-й. Stale timers очищаются, request budget и cooldown для known identity сохраняются.
  CLAUDE invariants записаны отдельным commit `ae9c65e`.
- Первоначальный reviewer v20 не выполнялся: `/private/tmp/claude-paired-review-final-20260906-v20/raw.json`
  сообщает session quota с reset в `17:10 Asia/Bangkok`. Exact Opus 5 retry прошёл `10:10Z`–`10:18Z`:
  `/private/tmp/claude-paired-review-final-20260906-v20-retry/report.json` и `meta.json` фиксируют
  verdict `clean`, 0 findings, resolved `2897de5`, actual model `claude-opus-5`, session
  `b073946a-ed7c-4ee2-8ba9-fa2b4953db59`. Requested effort xhigh; verified effort не наблюдаем
  (`null`). Final review gate закрыт; новый improvement/review cycle не нужен.
- Prepared `20260906T075300Z`/`20260906T075301Z` из `aab2dc0` superseded: не активировать и не
  перезаписывать их. После final review нужны два новых clean source-identical packages через
  обычный lifecycle. Docker/Caddy migration уже выполнена; оба rollback slots должны получить
  финальный fix до первого server activation.
- Загруженные `20260906T092401Z`/`20260906T092402Z` из `de36540` и локальные
  `20260906T094101Z`/`20260906T094102Z` из `5838c51` superseded и unused: не запускать prepare/activate.
- Final pair для `2897de5` собрана и uploaded на Irena в `10:19Z`. A `20260906T095601Z`, package SHA-256
  `d76e6c535e9e77192d66272011473fbcb221ef38ea2d0314847d0b71955dbe93`; B `20260906T095602Z`,
  SHA-256 `547025dc4bcf77a465bacb8a89aaf8b02025fb5e0eff18eaf4d6940c0c488175`.
  Local и remote checksums PASS, extracted source trees идентичны по `diff -qr`; strict preflights
  прошли. B activation затем не прошёл health gate; automatic rollback A тоже unhealthy из-за
  repeated unchanged `setMyName 429`. Web healthy, authority LOCAL, imports не выполнялись.
- Recovery fixes: `8c0b647` — profile read-before-write, `774f0ae` — guarded `prepare --repair-bot`.
  815 tests green; в `12:21Z` combined Opus runner завершился exit 1: organization disabled Claude
  Code subscription access. Actual model — `claude-opus-5`, accepted report отсутствует.
  Evidence: `/private/tmp/claude-paired-review-recovery-20260906/{raw.json,stderr.log}`.
  Владелец затем явно waived missing review только для emergency recovery `774f0ae`; deploy gate
  закрыт этим узким exception, не clean review. Не считать v20 на `2897de5` review этих fixes.
- Recovery pair `20260906T104101Z`/`20260906T104102Z` для `774f0ae` deployed: каждый package
  прошёл 815 tests, source identical/checksums и strict preflight PASS; оба `prepare --repair-bot`
  успешны. A activated `12:31:30Z`, B `12:33:21Z`; current B, previous A. Evidence:
  `/private/tmp/cometa-774f0ae-package-proof.GJ1xzO/source-diff.log`. CI `774f0ae` green в `12:16:08Z`,
  run `34032518573`.
- Full status/ledger status exit 0: `/private/tmp/cometa-104102-live-status.log`; 31-second
  health/TLS/API stable, zero restarts, `bot_polling_ready`, no repeated profile `429`.
  Root-only same-VPS WAL-safe backups: `20260906T122958Z-before-20260906T104101Z.sqlite` и
  `20260906T123205Z-before-20260906T104102Z.sqlite` в `/srv/cometa-bank/backups`.
- В `14:56:22Z` authority LOCAL, imports 0; оба Old snapshots по 438 rows сохранили hashes и
  compiled marker `104102`. Web John Cometa отдельно загрузил `104102`, 437 rows, 4 accounts.
- В `10:05Z` повторены 9 signed checks, PASS, и подтверждены прежние точные hashes двух native
  438-row snapshots. В `10:08Z` live health повторно healthy, authority LOCAL, canonical imports 0.
- Native inline coordinate clicks в Old и основном Telegram.app блокируются `-10005`; основной
  Cometa chat Nikita открыт через Cmd+K/Return, English click повторил ошибку в `10:07Z`.
  В `12:19Z` keyboard chat open сработал, coordinate Open Cometa вернул `AXError.notImplemented`.
  Затем owner QR-login в отдельном headed Chrome позволил реальный Web John Cometa onboarding
  English→KZT→ready→Open Cometa→consent→embedded Mini App без reset/mutation. Browser plugin
  остаётся без bindings. В `12:58Z` также прошли ChatGPT search (9, original Pending), Received
  filter (0), RU→English и KZT→USD→KZT display-only; 437 transaction/account hashes неизменны.
  Transfer `700000 KZT` blocked, shortfall `84040.43`, no submit. Foreground draft `123 KZT`
  сохранился при tab switch/back; native MainButton enabled, native Back закрыл sheet.
  Close → `/help` (четыре LOCAL commands) → новая Open Cometa → reopen прошёл. Proof `13:03:48Z`
  сохранил 437 rows/4 accounts и exact hashes, English/KZT/compiled104102/LOCAL. John Web gate закрыт.
- Два showcase visuals опубликованы в `51a2eb0`: реальные web screenshots и явно помеченный illustrative
  Telegram preview с точным copy реального bot engine. Это не native Telegram capture и не
  acceptance evidence. Источники: `docs/assets/showcase/README.md`. Linux CI для `de5395a` green,
  run `34027603574`; это не доказательство восстановления live bot.

### Local implementation and review history

Текущие results и открытые deploy/native acceptance gates указаны выше. Более ранние pending/review статусы
ниже сохранены как хронология; они не отменяют completed A/B bridge и не являются текущим task list.

- Historical candidate `de36540` прошёл 794 tests (572 web + 222 bot) в `09:21Z`. Последующий v18
  подтвердил три UX/lifecycle findings; они исправлены в `5838c51`. Этот checkpoint superseded
  последующими gates и не является final review verdict.
- Historical candidate `5838c51` прошёл 798 tests (576 web + 222 bot) в `09:39Z`/`09:40Z`, последний
  pass включал final copy. V19 затем нашёл terminal cold-session guard, исправленный в `2897de5`;
  его continuous-progress visual preference отклонён после immutable browser probe.
- Historical deployed-source checkpoint, 2026-09-06 (`5774b01`): `pnpm verify` passes 541 web + 222 bot tests, typecheck, lint,
  CSS/deploy/bundle guards and both production builds. `pnpm audit --prod --audit-level high`
  reports no known vulnerabilities. Full web suite also passes under UTC and America/New_York;
  the 49 fixture/format/History tests additionally pass under Pacific/Kiritimati.
- Browser checks: 10 isolated real-Chrome web journeys cover two-tab writes, reload, overdraft,
  search, RU/EN and 320/390/1440 widths. Nine synthetic signed Mini App journeys use the real HTTP
  server, HMAC validation, SQLite and production domain: per-user import/isolation, server writes,
  native MainButton bridge, offline quarantine, recovery and shared-storage profile switching.
  These are not real Telegram profile or phone acceptance.
- Added three cross-layer bot E2E tests with durable SQLite and the actual onboarding engine;
  duplicate confirmations, restart, canonical import, account lifecycle, recurrence backfill and
  rejected overdrafts preserve data. Named mutation checks proved the new assertions fail on a
  broken implementation.
- Independent Opus v10 found mixed local/UTC history and a mutating deployment dry-run; both are
  fixed. Live `ss` trailing padding exposed a strict-parser false negative, also fixed. Opus v11
  identified padding-sensitive snapshot comparison and timezone-dependent tests; the follow-up
  fixes are committed in `a0ef799`. Its proposed fixture timestamp shift was rejected because the
  owner requires UTC display and preservation of the accepted fixture. v12 found interior column
  padding and an undeclared `sed` dependency; `5774b01` uses already-required `awk` after strict
  validation, normalizing presentation only. Both removed-normalization mutants fail; v13 is clean
  (actual model `claude-opus-5`, requested xhigh, actual effort unobservable).
- Earlier focused runs during implementation covered fixture/future-bound validation, deep
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
  later gates supersede this checkpoint; the current candidate review status is recorded above.
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

1. Recovery deploy завершён и не требует повторения. Узкий owner waiver покрывает только missing
   Opus review emergency source `774f0ae`; тот review не выполнен, clean не заявлен.
   Не переносить waiver на будущие changes и не открывать дополнительный improvement/review cycle.
2. Focused John Web QA завершён на своём recorded build; оба Old реально переоткрыты на `173602`
   через AX Main Menu/account switching с сохранением 438 rows/exact hashes. Остальной ранее
   waived native scope не помечать tested. Namespace John не отождествлять с Old по display name.
3. WAL `.compat` fix выпущен в healthy `ef9a960` pair, CI 815 green. Новый blocker — SQL quoting
   в operator embedded Node eval: switch в `18:04Z` остановился до mode/restart/import. Исправление
   operator/harness в работе; после focused verification нужен новый immutable deploy без новой
   Opus попытки, затем guarded server retry. До его success mode LOCAL/imports 0.
   После verified activation
   импортировать по одному canonical snapshot на профиль и пройти изолированные RU/EN journeys:
   manual income/expense, recurrence с backfill/no-overdraft, add/adjust/close/restore и
   current→previous→current continuity. Не reseed existing snapshots ради валюты сценария и не
   подменять один из двух профилей John Cometa по имени.
4. Только после live journeys снять три sanitized Telegram captures в одну строку README и повторить
   public TLS/API/Playwright plus full verification. Текущие два visuals уже имеют provenance:
   actual web screens и explicit illustrative Telegram engine preview, не native screenshots.
5. Пройти Android/iOS Telegram WebView acceptance; desktop/browser emulation его не заменяет. Только
   после этого можно выводить Hostinger origin из эксплуатации и обсуждать HSTS.
6. До любого нетестового/публичного использования revoke/rotate установленный exposed test token и
   поставить замену через hidden-TTY `release.sh install-token`. До rotation закрыть deferred
   uutils/NSS restorePrevious mismatch в `deploy/bot/install-secret.sh`; текущий token не менялся.
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
synthetic fixtures добавлены рядом, а не поверх него. Existing owner rows не сбрасывались;
оба current 438-row snapshots сохраняются отдельно от frozen fixture. Source `5774b01` deployed как B
`20260906T071101Z` с previous A `20260906T071100Z`, но новый milestone не принят и authority
остаётся local. Candidate `2897de5` прошёл 799 tests и immutable browser 5 scenarios / 19 checks;
terminal finding v19 исправлен, visual preference отклонён с browser/CLAUDE evidence. После
исторической quota failure exact Opus 5 v20 retry завершён в `10:18Z`: clean, 0 findings на `2897de5`.
Final pair `095601`/`095602` uploaded в `10:19Z`, local/remote checksums/source parity PASS;
strict preflight выполняется, activation ещё не было.
`092401`/`092402` и `094101`/`094102` superseded и не должны проходить prepare/activate. Завершить
существующий gate без нового improvement cycle, затем продолжить
normal lifecycle и переснять Irena/DNS/TLS/ledger-mode health. До первого server activation
нужны final compiled markers и foreground/snapshot preservation в обоих native profiles.
В `10:05Z` повторены 9 signed checks и точные hashes двух 438-row snapshots; live LOCAL/zero imports
и health подтверждены в `10:08Z`. Coordinate inline clicks возвращают `-10005` также в разрешённом
основном Telegram.app (`10:07Z`); Browser plugin не видит connected browser. Ответ на просьбу
Settings → Computer use / Web Telegram login не получен; John Cometa не идентифицирован.
Точная очередность записана в `docs/next-phase.md`.

Старый source milestone, English product README, showcase и CI опубликованы в public GitHub repo
`nikitacometa/mock-bank-app`; локальный `main` отслеживает `origin/main`. Owner явно выбрал public
visibility при сохранении fingerprintable KZT fixture. Новые три Telegram screenshots пока не
сняты с accepted live mutation journeys. Два локально обновлённых showcase visuals используют
actual web screenshots и явно обозначенный illustrative Telegram preview с точным engine copy;
provenance сохранён в `docs/assets/showcase/README.md`. Они не являются evidence live server-mode
Telegram acceptance.
