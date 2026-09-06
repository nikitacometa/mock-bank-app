# Cometa Bank — спека mock-необанка (web → Telegram Mini App)

Дата: 2026-09-01. Метод: двухдвижковый брейншторм (/brainstorm) — два независимых архитектурных
трека, 5-линзовый ресёрч (все факты с URL и датой доступа), симметричное кросс-ревью, red team,
user-lens walkthrough. Артефакты рана — в scratchpad сессии (`brainstorm-kaspy-bank/`), ключевые
факты перенесены сюда. Sol (GPT-5.6) в этом ране недоступен — Track B вёл Claude в контрастной
MVP-first роли (см. Приложение).

## 0. Addendum: multi-user Telegram demo

Дата решения: 2026-09-05. Этот раздел и
`docs/internal/TELEGRAM_LEDGER_DESIGN_2026_09_05.md` заменяют более ранние утверждения ниже о
client-only Telegram ledger, fixed four-account product scope и backend только для preferences.

- Обычный web-demo остаётся device-local. В Telegram Mini App SQLite хранит authoritative
  `BankState` отдельно для canonical Telegram ID; bot и TMA применяют к нему общий pure domain через
  typed idempotent commands.
- Fresh fixture начинается с четырёх role-accounts в выбранной из восьми base currencies. KZT
  сохраняет owner fixture, остальные семь fixtures полностью synthetic, country-specific и
  выровнены по USD-value. После старта пользователь может добавлять checking accounts,
  корректировать balance ledger-строкой и reversible close/restore счета.
- Manual income/expense и monthly recurrence работают только для active checking accounts.
  Расход, включая atomic historical backfill до 120 UTC-месяцев, не может увести баланс ниже нуля.
  Savings допускает current adjustment только после interest settlement.
- Первый authenticated device snapshot импортируется create-if-absent и становится canonical.
  Sticky authority marker запрещает возврат к local writes. Отличающаяся pre-authority копия на
  втором device не перезаписывается молча: пользователь явно выбирает server copy.
- TMA rate refresh accepts no provider payload: the backend owns Frankfurter access and a 12-hour
  process cache. User operations use a bounded 8,192-row sliding replay window; pending delivery,
  imports and system materialization are never evicted. Recurring-warning outbox rows freeze their
  user-facing context at commit time.
- A request bypasses the mutation budget only when the exact operation ID and canonical payload
  hash are already committed in SQLite. Invalid, conflicting and crash-before-commit retries are
  charged; a committed domain failure is replayed as its stored outcome. Canonical parsing
  deep-projects every nested state object and rejects future metadata.
- Authenticated bootstrap is capped at 30 requests per canonical Telegram ID per minute after HMAC
  validation but before SQLite lookup; it has no replay exemption. Every canonical server read
  settles savings first, then materializes recurrence, and remains idempotent on the same UTC day.
  Client preflight submits `settle` only when its adopted state still has an overdue active savings
  anchor or an active due recurring rule, and coalesces concurrent calls per Telegram ID. A canonical
  bootstrap is therefore a no-op, while an unmaterialized first import and UTC rollover still settle.
  A pure bounded preflight suppresses a positive-interest batch that cannot fit at the exact
  5,000-row ceiling instead of spending ingress/replay capacity on an impossible command. Local mode
  keeps its device-side path, including verified Telegram foreground resumption.
- Signed import and command routes charge non-replayable per-user ingress budgets after HMAC but
  before body parsing and canonical hashing. A persisted exact replay bypasses only the narrower
  mutation budget, never ingress.
- Wizard steps atomically persist the next conversation session with its reply receipt. Delivery
  and Telegram update processing have separate durable bits/retention, so either crash order
  resumes the prompt before later input is accepted. A pending per-user reply is drained even when
  its source update was not yet marked processed, preventing a newer wizard step from colliding with
  the one-pending-reply constraint. Amount messages are normalized and bounded to
  the canonical 64-code-point command limit before either preview or durable draft storage. Every
  review rotates its opaque flow ID, binding Confirm to that exact draft; language changes replace
  an active wizard with a localized dashboard, and stale buttons cannot reinterpret later input.
  Account reviews also bind the displayed balance/status, while recurrence reviews bind every
  mutable execution precondition: rule, account status/balance, UTC day and history capacity. A
  changed snapshot requires a new review. If a prior attempt already committed the exact Telegram
  update and command hash, retry enters the durable replay path before these preview checks.
- A raw Telegram launch-session fingerprint starts an identity epoch before the possibly stale
  parsed SDK user is trusted. Same-user foreground sync preserves valid UI state; a canonical
  adoption closes only invalid account/card/transfer targets, while a namespace change resets all
  transient state.
- Production authority включается только после двух authority-capable immutable releases.
  Односторонний switch и последующие activate/rollback защищены `release.sh ledger-mode` guards.
  Повторный `server --apply` при уже включённом server mode пишет durable reconciliation audit и
  повторяет health gates без ledger mutation. Local-mode bot публикует только non-mutating command
  profile and keeps `/start` plus preference callbacks on the ordinary launch/ready cards; после
  durable final switch event operator restart'ит current bot, чтобы startup
  опубликовал server commands, затем выдерживает 31-second health/TLS gate.

Это по-прежнему mock без реальных денег, KYC, bank connections или payment rails. Полный текущий
implementation status и verification evidence живут в `docs/handoff.md`.

## 1. TL;DR

Mobile-first SPA: **Vite + React 19 + TS + Tailwind v4 + Zustand + custom localStorage persistence**,
без роутера (state machine экранов), Dexie и motion-библиотек. Баланс — производная
от лога транзакций; отдельного мутируемого поля баланса нет. Деньги хранятся как
безопасные целые minor units. Валютный домен поддерживает KZT, THB, VND, RUB, USD, EUR,
IDR и GEL; fresh demo содержит четыре role-счёта, а account lifecycle позволяет добавлять и
reversible close/restore пользовательские checking accounts.
Основная валюта настраивается, reference rates загружаются из Frankfurter, а FX snapshot
остаётся неизменяемым на обеих ногах кросс-валютного перевода.

Platform seam (`platform/*`) и машинные гарды изолируют браузер и Telegram. Web-адаптер
работает; Telegram-адаптер мигрирован на maintained `@tma.js/sdk-react` 3.0.23 и покрыт
тестами. Local Node 22 candidate extends RU/EN onboarding into per-user bank wizards and owns the
Telegram mock ledger after a guarded server-mode activation; ordinary web remains local. Its signed
API covers create-if-absent import, typed commands and backend-only rate refresh. This candidate is
not deployed yet. BotFather Main Mini App/menu/profile настроены, а signed bootstrap предыдущего
release уже прошёл в Telegram Desktop WebView; новый ledger flow и Android/iOS acceptance ещё не
приняты. Authoritative DNS `euphoria.bot` переведён на выделенный
Irena VPS; release `20260902T233133Z` active/healthy, identical-source release
`20260902T233104Z` — automatic previous, D→C→D rollback rehearsal пройден. Hostinger остаётся
TLS-valid external rollback origin до full real-device pass; проверенные
system/Cloudflare/Google/Quad9 resolvers сходятся на Irena. Дизайн: холодный near-black, ivory CTA, минт только
для роста/успеха, локальные Geist/Geist Mono, сгенерированные currency badges и scroll-snap
карусель карт. Бренд в UI — **«Cometa»**, не «Kaspy».

## 2. Задача и контекст

Pet-проект-эксперимент: минималистичный mock-банк с полировкой уровня настоящего необанка 2026.
Скоуп: четыре fresh role-счёта (current + savings в base currency и два companion accounts),
закрытый набор из восьми поддерживаемых валют (KZT/THB/VND/RUB/USD/EUR/IDR/GEL), история,
мок-карты, переводы между своими счетами с FX и переводы мок-контактам. Все банковские
данные вымышлены: web хранит их на устройстве, а Telegram после activation хранит отдельный
authoritative snapshot на сервере для каждого canonical Telegram ID. Внешние границы ограничены
read-only reference rates и этим server-authoritative Telegram mock-ledger с chat UX.
Фаза 1 — веб-аппка
(mobile-first, десктоп терпимо-адаптивен), фаза 2 — Telegram Mini App; архитектура обязана
сделать порт «днями, не неделями». Не в скоупе: кредиты, реальные интеграции, KYC, реальные деньги.

Критерии успеха: (1) на телефоне выглядит и ощущается как прод-необанк, не демка; (2) все флоу
реально двигают состояние; (3) маленькая чистая кодовая база; (4) порт в TMA — дни.

## 3. Рынок и референсы (дайджест ресёрча, источники — доступ 2026-09-01)

Канон жанра — 5 паттернов, сходящихся у Revolut/Monzo/N26/Wise/Т-Банк:
1. Баланс крупно наверху + переключатель счетов под ним ([Revolut](https://www.revolut.com/blog/post/meet-pockets-the-next-evolution-of-vaults), [Monzo](https://monzo.com/blog/the-new-and-improved-home-screen)).
2. Копилка/суб-счёт — первоклассный визуальный объект; жанр 2025 разводит «цель без дохода» и
   «продукт с процентом» (Revolut Pockets vs Savings, Monzo Pots vs interest Pots).
3. Транзакции: мерчант-иконки + чистые имена, группировка по дате (N26 redesign, [jonnyczar.com](https://www.jonnyczar.com/project/n26)).
4. Карта — управляемый объект в приложении: freeze, дизайн, реквизиты (Cash App).
5. Тёмная тема у топ-необанков — дефолт или first-class; бренд-цвет адаптируется вручную, не
   автоинверсией ([Nubank Building](https://building.nubank.com/the-birth-of-the-dark-mode-a-journey-into-nubanks-app-evolution)).

Open source: **ничего не брать целиком** — прямой обзор кандидатов (`shadcn-fintech`,
`react-banking-app-template`) показал чужой скоуп/не-премиум эстетику; писать с нуля быстрее и
чище. Seed генерируется локальным детерминированным `mulberry32` в `src/domain/seed.ts`;
`@faker-js/faker` не используется ни в runtime, ни как dependency.

Telegram Mini Apps: legacy `@telegram-apps/*` packages помечены unsupported; adapter мигрирован
на `@tma.js/sdk-react` 3.0.23 / `@tma.js/sdk` 3.3.0 (проверено 2026-09-02);
грабли: `100vh` → `var(--tg-viewport-height)`, `viewportStableHeight`, два разных safe-area
инсета, живой Android-баг самоперезагрузки WebView (issue #86), iOS чистит localStorage при
потере сессии. 🔴 Форма продукта (мок-баланс + рост) совпадает с задокументированным паттерном
скам-мини-аппов ([CTM360/FEMITBOT, май 2026](https://www.ctm360.com/reports/femitbot-telegram-mini-apps-fraud-campaigns)) —
disclaimer в UI обязателен, countdown-таймеры на начислениях запрещены.

Дизайн 2026: Inter — AI-slop-маркер (3 независимых источника), indigo/purple-градиент — тоже;
tabular-nums на деньгах — практическая необходимость (count-up без прыжков ширины); bottom
sheets вместо модалок; spring-физика на интерактиве; skeleton-состояния обязательны.

Полный дайджест с URL по каждому факту — в артефактах рана (`digest.md`).

## 4. Пространство решений: рассмотрено → отвергнуто

| Подход | Кто предложил | Почему отвергнут |
|---|---|---|
| Next.js «на вырост» | Track A v1 | При нынешнем клиентском моке Vite отдаёт готовую статику на Hostinger; backend потом можно добавить отдельно. SSR/hydration не дают ценности сейчас |
| Svelte 5 (быстрее, меньше бандл) | ресёрч stack | React уже выбран и вся UI/domain test surface написана; смена stack дороже изолированного adapter seam, который уже мигрирован на maintained `@tma.js/sdk-react` |
| React Router | Track A v1 | На 3 экранах + шитах роутер не окупается; BackButton-привязку в TMA всё равно писать руками; стейт-машина — 15-20 строк (механизм уточнён кросс-ревью: Router в TMA технически работает, но не даёт выгоды) |
| Dexie/IndexedDB | ресёрч stack (digest) | Масштаб демо не окупает вторую модель persistence. Внутри вкладки обе ноги перевода пишутся одним `set()`; между вкладками read-modify-write перевода сериализует Web Locks с перечитыванием persisted state. iOS-очистка — довод за persistence seam, а не за Dexie |
| Полный банковский backend с день 1 (Hono/Workers) | Track A v1 (вариант C) | Исходный full-backend scope был преждевременным. После выбора multi-user demo добавлен узкий SQLite authority только для Telegram mock-ledger; web и real-money rails в backend не переехали |
| Форк open-source шаблона | ресёрч opensource | Чужой скоуп дороже вырезать, чем написать 4 экрана с нуля; мёртвые абстракции против «маленькой чистой базы» |
| shadcn/ui как визуальная система | оба v1 | Дефолтный скин = generic-2026 антипаттерн. НО: headless-механика Radix Dialog (focus-trap, portal, scroll-lock) для Sheet — берём, скин свой |
| Motion/framer-motion глобально | оба v1 | Единственные не-CSS анимации — count-up (~30 строк RAF) и card-tilt (~50 строк). Библиотека — только если M6 упрётся |
| Второй акцентный hue (фиолетовый) | Track A v1 | Дисциплина «≤3 фокальных элементов» эрозирует вдвое быстрее с двумя hue; фиолетовый двусмыслен (премиум vs AI-slop) |
| Два семейства шрифтов | Track A v1 | Вторая поверхность кириллического риска без структурной необходимости |
| Палитра «Ember Neon» (flexq) | recon | Банк не должен визуально читаться тем же продуктом, что AI-тул владельца. Переиспользуем методологию (oklch, двухслойные токены, glow-дисциплина), не палитру |
| `User`-сущность | Track A v1 | Таблица с гарантированно одной строкой = косвенность без функции; плоский `profile`-слайс |
| Account.principal как мутируемое поле | Track B | Два источника истины (поле + лог); ledger-derived баланс делает рассинхрон структурно невозможным |
| Золото как основной акцент | оба v2 | Red team: «чёрный + золото» — клише банковской индустрии старше AI-slop; ушли в монохром + минт (см. §5.6) |

## 5. Выбранная архитектура

### 5.1 Структура и data flow

```
src/
  main.tsx               — глобальные tokens.css → React root
  app/App.tsx            — ErrorBoundary → PlatformProvider → BootstrapGate → Shell; Shell выбирает screen,
                           рендерит один ActiveSheet и постоянный Toast live-region
  store/uiStore.ts       — state machine: screen 'home'|'history'|'cards' + один Sheet union,
                           locale, activeAccountId и FIFO toast queue; роутера/sheet-стека нет
  platform/
    types.ts             — PlatformAdapter: getCurrentUser(), haptic(), copyText(),
                           mainButton и armBack(); getCurrentUser — прямой метод, не auth namespace
    usePlatform.tsx      — выбирает web/Telegram adapter; bounded Telegram init/retry
    adapter.{web,telegram}.ts — реализации одного контракта
                           ESLint no-restricted-syntax: window.Telegram
                           и голый localStorage.* вне platform/** и store/** — ошибка линта.
                           env(safe-area-inset-*) разрешён ТОЛЬКО в tokens.css/viewport —
                           grep-проверка в CI (линт CSS не видит)
  domain/                — чистые функции: money, currency/FX, interest, transfer,
                           ledger, seed; invariants (dev-only)
  services/              — строгий Frankfurter client: timeout, bounded UTC range,
                           последний полный same-date quote set и проверка свежести
  store/                 — Zustand slices (accounts, transactions, cards, contacts, profile)
                           + primaryCurrency/exchangeRates + custom persistence(localStorage, schemaVersion,
                           migration/reset с видимым тостом) + storage-event cross-tab sync
                           + Web Lock/persisted rebase + in-memory-authoritative mode after failed writes
  ui/primitives/         — Button, Amount (tabular-nums + count-up), Sheet (Radix headless + свой скин),
                           Avatar, CurrencyBadge, кастомные inline-SVG иконки
  ui/screens/            — Home, History, Cards
  ui/screens/sheets/     — один TransferSheet с initialMode 'own'|'contact',
                           AccountDetailSheet, CardDetailSheet, SettingsSheet
  styles/tokens.css      — @theme: oklch-палитра (dark), типографика, radius, --ease, --app-height
bot/                     — dependency-free Node 22 polling worker: RU/EN onboarding + bank wizards,
                           SQLite preferences/authoritative BankState/typed outboxes,
                           Bot API setup, signed bootstrap/import/command endpoints + /healthz
deploy/bot/              — hardened container, file-only secret, activation/rollback runbook
```

Данные в одну сторону: `domain` (pure) → `store` (единственное место мутаций) → `ui` (селекторы +
экшены). Компоненты не трогают `window.*`/`localStorage` напрямую — гард инструментом, не конвенцией.

### 5.2 Модель данных (синтез: ledger-модель A + edge-механика B)

```ts
type Money = number;                     // целые minor units, никогда float
type Currency = 'USD'|'EUR'|'RUB'|'KZT'|'THB'|'VND'|'IDR'|'GEL';
type DemoFixtureId = 'owner-kzt-v1' | 'synthetic-thb-v1' | 'synthetic-vnd-v1'
  | 'synthetic-rub-v1' | 'synthetic-usd-v1' | 'synthetic-eur-v1'
  | 'synthetic-idr-v1' | 'synthetic-gel-v1';

interface ExchangeRateSnapshot {
  base: 'USD'; asOf: string; fetchedAt: string; source: 'frankfurter'|'fallback';
  rates: Record<Currency, string>;        // decimal strings: major units per 1 USD
}

interface Account {
  id: string; type: 'checking' | 'savings'; name: string; currency: Currency;
  role: 'primary-checking'|'primary-savings'|'companion-1'|'companion-2'|'custom';
  status: 'active'|'closed'; closedAt?: string;
  number: string;                        // мок-реквизиты: «40817 810 …» — для экрана реквизитов
  apy?: number;                          // только savings; ВИДИМ в UI (бейдж «X% годовых»)
  accrualAnchor?: string;                // ISO, последний settle
  createdAt: string;
}

interface Transaction {
  id: string; accountId: string; seq: number;      // seq — монотонный, решает ties по времени
  amountMinor: Money;                              // знак: + приход, − расход
  balanceAfterMinor: Money;                        // БАЛАНС СЧЁТА = balanceAfterMinor последней строки
  kind: 'purchase'|'transfer_own_out'|'transfer_own_in'|'transfer_contact'|'interest'|'topup'|'seed'
      | 'manual_income'|'manual_expense'|'balance_adjustment';
  status?: 'posted'|'pending';                    // отсутствие = posted; pending резервирует available balance
  counterparty?: string; category?: string;
  transferGroupId?: string;                        // связь двух ног own-transfer — ДЛЯ UI
  note?: string; effectiveDate?: string;
  recurringRuleId?: string; occurrenceKey?: string;
  fxSnapshot?: {                                  // один immutable snapshot на обеих ногах
    fromCurrency: Currency; toCurrency: Currency;
    fromAmountMinor: Money; toAmountMinor: Money; rate: string;
    fromUsdRate: string; toUsdRate: string;       // exact frozen base quotes для audit/replay
    asOf: string; fetchedAt: string; source: 'frankfurter'|'fallback';
  };
  createdAt: string;
}

interface Card { id; accountId; brand: 'visa'|'mastercard'; last4; holder; expiry;
                 design: 'midnight'|'ivory'|'mint'; status: 'active'|'frozen';
                 freezeReason?: 'manual'|'account_closed' }
                 // полного номера НЕТ нигде — ни в модели, ни в DOM (grep-AC)

interface RecurringRule {
  id; accountId; direction: 'income'|'expense'; amountMinor: Money; counterparty; note?; category;
  cadence: 'monthly'; anchorDay: number; startsOn: string; nextOccurrence: string;
  status: 'active'|'paused';
  pauseReason?: 'manual'|'account_closed'|'capacity'|'overflow'|'insufficient_funds'; createdAt;
}

interface Contact { id; name; initials; lastTransferAt?: string }   // сортировка: recent first
interface Profile { displayName; telegramId?: string }
interface BankState {
  primaryCurrency: Currency;
  demoBaseCurrency: Currency;
  fixtureId: DemoFixtureId;
  exchangeRates: ExchangeRateSnapshot;
  accounts: Account[]; transactions: Transaction[]; recurringRules: RecurringRule[];
  // cards, contacts, profile, nextSeq, recentTransferIds
}
```

**Баланс = `balanceAfterMinor` последней строки лога** (по `seq`). Отдельного поля баланса нет —
рассинхрон «баланс ≠ сумма транзакций» структурно невозможен. Dev-инвариант (throw в DEV, no-op в
PROD): сумма `amountMinor` по счёту == последний `balanceAfterMinor`. Все денежные значения —
safe integers в ISO minor units; FX-арифметика идёт через decimal strings и `BigInt`, а не через
floating-point `Number`.

**Проценты** — материализуются строками лога, без таймеров:
```ts
epochDayUTC(iso)  // календарные UTC-дни — устойчиво к DST/переводу часов
days = max(0, epochDayUTC(now) - epochDayUTC(anchor)); if (days === 0) → no-op
amount = round(balance * ((1 + apy/365)^days - 1))   // одна строка за весь catch-up
```
Триггеры settle: загрузка приложения + перед любой мутацией savings-счёта (иначе проверка
достаточности средств не видит несведённые проценты).

**Перевод** — `transfer({from, to|contact, amountMinor, clientTransferId})`. Чистый domain-переход:
settle-если-нужно → валидация → обе ноги + строки лога одним `set()`. Для кросс-валютного
перевода сумма конвертируется один раз; одинаковый `fxSnapshot` с курсом, датой и обеими
суммами записывается в обе ноги. Persistence-валидатор пересчитывает этот FX и отклоняет
подменённый persisted state. Store оборачивает в exclusive Web Lock все whole-state mutators
(`transfer`, primary currency, rates, settle, card freeze, reset) и внутри него перечитывает свежий persisted
state. Local transfer проходит через тот же bounded `applyBankCommand`, что и server mode: contact
leg и обе own-account legs preflight'ят общий 5,000-row ceiling и при `capacity` не меняют state.
First-run seed выбирается под тем же lock. После failed persistence write текущий in-memory
state остаётся authoritative и не откатывается stale storage/event до успешной записи. Rejected
lock acquisition даёт один unserialized run; ошибка callback пробрасывается без повтора transition.

`clientTransferId` (генерится UI на submit) — идемпотентность через ring-buffer последних 50.
Новый переход возвращает `{ok:true, applied:true}` и для own-transfer точный
`incomingAmountMinor`; повтор → `{ok:true, applied:false}` без receipt. Кнопка дизейблится
на клик — идемпотентность вторая линия, не единственная. `transferGroupId` — отдельный, только
для группировки в UI.

**Manual and recurring entries** target active checking accounts only. A monthly rule selects an
explicit UTC start year, month and billing day; historical materialization is atomic and capped at
120 rows. Every expense prefix is preflighted, so no committed command can make the mock balance
negative. Resuming an already-active rule is an exact `applied: false` no-op. Savings supports only
a current balance adjustment after interest settlement.

Account and recurring confirmations re-preview the latest canonical state before submitting their
typed command. A still-valid account command is also re-reviewed when its displayed balance or
status changed. A recurrence review fingerprints the full rule, account status/balance, UTC day and
transaction count, so Resume cannot report success from a stale balance/capacity projection. Domain
errors expose a recovery action; successful drift rotates the review callback instead of silently
reusing it.

**Account removal** is reversible close at zero balance, not deletion. History remains. Linked
rules/cards pause or freeze with `account_closed`; restore reverses only that automatic reason and
preserves manual pauses/freezes.

### 5.3 Навигация и экраны

Таб-бар, 4 пункта: **Главная · История · [центр, акцент] Перевод · Карты**. «Перевод» открывает
sheet, не экран (канон «CTA-жест» + тач-зона большого пальца). Настройки — иконка в шапке →
SettingsSheet. `useBackGesture()`: popstate/edge-swipe закрывает верхний sheet; в фазе 2 — тот же
call-site на `backButton.onClick()`.

1. **Home** — hero-карточка активного счёта, горизонтальный account rail с currency badges,
   count-up на изменение (не на маунт), tabular-nums; у накопительного — видимый APY-бейдж;
   у любого активного не-USD счёта — отдельный USD-эквивалент с датой live-курса или честной
   пометкой «демо-курс», независимо от основной валюты; ниже — total всех счетов в выбранной
   основной валюте;
   компактный демо-водяной знак на hero (постоянный, читаемый — не «мелкий шрифт для галочки»);
   превью последних 3-5 транзакций.
2. **History** — группировка по дням, **текстовый поиск** (мерчант/контакт) + фильтр по типу,
   ноги own-transfer визуально связаны (одна строка «Перевод на Накопительный» на счёте-источнике
   с иконкой связи), спроектированное пустое состояние.
3. **Cards** — scroll-snap карусель (нативный жест, 0 JS) + лёгкий pointer-tilt слой; тап → sheet:
   реквизиты счёта (номер, copy-to-clipboard), freeze/unfreeze, last4-only.
4. **TransferSheet** — один sheet с режимами own/contact: счёт-источник и получатель → сумма
   (крупный ввод, live FX-превью для разных валют) → подтверждение той же CTA (текст кнопки
   содержит сумму в валюте счёта-источника —
   подтверждение получателя и суммы слито в кнопку). Success-сцена: галочка + haptic ~800 мс →
   авто-закрытие → баланс на Home делает count-up. Флоу намеренно короткий (окно уязвимости к
   TMA-ремаунту минимально). CTA живёт за platform-seam (в TMA станет MainButton без правки экрана).
5. **SettingsSheet** — выбор основной валюты, статус/ручное обновление Frankfurter rates, сброс
   демо-данных (тот же код-путь, что migration-reset) и полный disclaimer-текст.

Первый маунт: сид генерится синхронно (<50 мс на 150 строк) — белого кадра нет; если появится,
skeleton, не спиннер.

### 5.4 Дизайн-направление

- **Тема:** dark-only фаза 1. Семантические oklch-токены с первого коммита (`--color-bg/surface/
  text/accent/positive/negative`). Telegram dark host может перепривязать только нейтрали;
  light host оставляет brand-safe базовую схему. **Бренд-акцент исключается из
  авто-привязки `bindCssVars()`** (red team: иначе Telegram-тема юзера молча съест фирменный цвет).
- **Цвет:** холодный near-black (дистанция от тёплого Ember Neon — банк ≠ flexq), два уровня
  surface. Монохром-first: главный «акцент» — тёплый ivory на CTA и hero-числах. Один цветовой
  акцент — сдержанный минт (рост/накопительный/успех). Красный приглушённый — только знак расхода.
  Анти-цели: indigo/purple-градиент, acid-green на чёрном (AI-дефолт), золото-люкс (клише банков),
  красно-оранжевый (Kaspi).
- **Типографика:** self-hosted variable Geist + tabular-nums на всех деньгах; self-hosted
  Geist Mono на номерах карт/реквизитах. Кириллица проверена в живом рендере; сетевого font-запроса
  нет. Крупные числа hero — оптический размер/трекинг, не вторая гарнитура.
- **Движение:** CSS 120-180 мс, свой ease `cubic-bezier(0.22,1,0.36,1)`; useCountUp (RAF, ~30
  строк); card-tilt — единственный сигнатурный жест (не переоцениваем: жанровый приём, а не УТП);
  glow/акцент — состояние, не декор, ≤3 фокальных элементов на экран; `prefers-reduced-motion`
  выключает необязательное.
- **Иконки:** кастомный минимальный inline-SVG набор (~15 штук, единая толщина штриха) — не
  дефолтный Lucide-с-коробки (red team: маркер AI-UI того же класса, что Inter).
- **Currency badges:** для восьми валют лежат сгенерированные тематические assets; поверх них UI
  рисует реальный символ/код валюты обычным текстом, так что accessibility и точность не зависят от
  растра.
- **Копирайт — поверхность дизайна:** разговорный русский, без канцелярита, по гайду владельца;
  отдельный проход в M6 (пустые состояния, ошибки, подписи). «У вас пока нет операций» — запрещено.
- **Seed-данные — дизайн-задача, не техпункт:** 369 обезличенных строк owner statement за
  2025-12-19…2026-06-30 сохраняют точные KZT-даты/суммы и 298 purchases; PII, банковские
  identifiers, P2P-имена и reference suffixes удалены. Нейтральная ledger-строка `+4 571,26 ₸`
  сводит внутреннее расхождение PDF к напечатанному closing balance, не приписывая ему причину.
  Заблокированный ChatGPT 19 июня помечен `pending`. После выписки идёт детерминированное
  продолжение до 2026-09-02 по реальным merchant-паттернам. Exact sanitized history остаётся
  fingerprintable, потому что попадает в public client bundle.

### 5.5 Данные и надёжность демо

- Zustand + custom localStorage persistence, один ключ, `schemaVersion: 5` с explicit v4 migration; несовпадение старой версии / битый JSON /
  невалидная форма → видимый сброс к сиду с тостом, не белый экран и не тихий partial-hydrate.
- `storage`-event доставляет состояние между вкладками; все whole-state mutators дополнительно
  сериализованы через Web Locks и перечитывают persisted state внутри lock. Bootstrap также под lock;
  failed write включает in-memory-authoritative mode. Notices идут FIFO через заранее смонтированный
  live-region и не перетирают recovery/rates. Rejected Web Lock может деградировать в single-run
  fallback только в том же persistence namespace; смена Telegram identity вместо этого abort'ит
  stale mutation. Runtime boundary строит exact deep projection не только top-level `BankState`, но
  и rate/account/transaction/FX/card/contact/profile/rule objects; unknown nested keys не попадают в
  persistence или canonical digest. Future account/closure/accrual, transaction/FX/contact и rule
  metadata отклоняются относительно trusted current clock.
- Frankfurter запрашивается с base USD и точным набором из семи quotes за bounded UTC range
  `fetchDay-7…fetchDay`. Последний полный same-date набор выбирается атомарно; carry-forward rows
  разных observation dates не смешиваются. Timeout — 8 секунд; decoded body ограничен 256 KiB,
  payload — 64 rows, snapshot кэшируется на 12 часов.
  Provider date не может быть из будущего или отставать более чем на семь UTC-дней. Delayed response
  не заменяет более новый snapshot (`asOf`, затем `fetchedAt`). Web вызывает read-only provider
  напрямую; server-mode TMA отправляет только signed refresh request, а backend владеет payload,
  process-wide cache и in-flight dedupe. Provider failure или regressing candidate включает общий
  30-second retry cooldown и не меняет canonical snapshot. `/bank-rates` имеет отдельный
  non-replayable per-user budget: повтор `clientMutationId` всё равно считается новым refresh.
- ErrorBoundary на корне: fallback «что-то пошло не так → Перезапустить демо» (сброс к сиду).
  Худший провал продукта — крэш на живом показе, это требование того же ранга, что дизайн.
- Web-демо и TMA-демо на одном устройстве — РАЗНЫЕ storage: состояние не переносится, это ожидаемое
  поведение, не баг. Внутри одного TMA origin bank/locale/receipt дополнительно разделены по
  canonical Telegram ID. До HMAC-verified bootstrap работает неперсистентный quarantine; unknown
  identity не видит и не перезаписывает предыдущий snapshot. Legacy singleton копируется только
  при точном совпадении verified ID. Fingerprint raw launch session открывает новый synchronization
  epoch до чтения parsed SDK user; obsolete foreground response не может заново открыть прежний
  namespace. Same-user adoption сохраняет валидные screen/sheet/draft/toasts и History selection
  закрытого счёта, но закрывает sheet/transfer targets, которых больше нет в canonical
  account/card/contact topology. Полный `resetUi()` выполняется только при реальной
  persistence-namespace boundary.
- Telegram `initData` считается недоверенным до server-side HMAC validation. `/api/tma/bootstrap`
  принимает только пустой JSON body + `Authorization: tma <raw-init-data>`, проверяет подпись,
  duplicate keys, future skew и 24-hour freshness bound, затем возвращает versioned preference
  projection и additive bank projection. Каждый response с canonical bank state содержит exact
  UTC `serverTime`, canonical Telegram ID, epoch, revision, digest and state; `import_required`
  state не содержит. Frontend проверяет timestamp против device clock только широким 24-hour sanity
  bound, а сам `BankState` валидирует относительно `serverTime`, поэтому секундный clock skew не
  превращает корректный server snapshot в ошибку. Receipt связывает revision fields с BankState schema.
  Смена аккаунта сначала скрывает прошлый state, затем получает его отдельный authoritative snapshot
  или проходит strict create-if-absent import. Первый accepted device snapshot становится canonical;
  отличающаяся local copy другого device требует явного перехода на server copy. Strict import
  отклоняет future immutable timestamps, recurrence вне разрешённого UTC window, неверное
  role/type/base-currency mapping и duplicate active checking currencies.
  После HMAC validation bootstrap списывает отдельный per-user budget `30/min` до `ensureUser` и
  bank-state lookup; у read-запроса нет replay exemption. Canonical server read под repository lock
  всегда выполняет `applySettleAll` до recurring materialization. Эту функцию используют bootstrap
  и bot chat reads; повтор в тот же UTC-день не создаёт interest/occurrence rows и не повышает
  revision без изменения state. Если materialization превысит 4 MiB snapshot limit, bootstrap
  возвращает последний canonical snapshot без частичного write. `reset_demo` обходит due
  materialization и остаётся recovery path; обычные увеличивающие state команды возвращают typed
  `413 bank_state_too_large`.
- Bot SQLite хранит `telegram_user_id`, locale, display name, onboarding state, authoritative mock
  `BankState`, command ledger, recurring conversation drafts, `conversation_replies` receipts и typed
  outbox. Все bank rows изолированы по authenticated Telegram ID; первый import create-if-absent.
  Каждый wizard transition пишет новый session и предназначенный ему reply одной SQLite transaction.
  Reply delivery и `update_processed` фиксируются независимо: pending processed receipt переживает
  bounded processed-ID pruning, delivered-before-processed receipt удаляется после acknowledgement,
  а delivered orphan истекает с six-day sequence-reset window. Query parameters используются везде;
  unexpected 500 получает только safe server-side metadata без request body, Authorization и
  provider description.
- Authority activation requires a per-user client-contract marker emitted by the exact running
  build. Both BotFather Main Mini App and per-user menu URLs use `/app/<release-id>/` as a fresh
  cache key; a cached root document is not accepted as bridge evidence. Well-formed versioned paths
  fall back to the current image during rollback, whose compiled marker identifies the served build.
- User-created `telegram`/`tma` operation history is a sliding window capped at 8,192 rows per user.
  Exact retries are resolved while retained. Before a fresh command, the oldest row without pending
  outbox is evicted in the same SQLite transaction; rollback restores it if the replacement fails.
  Import and system materialization remain outside that budget, and pending delivery is never
  evicted. If every retained row is protected, the command fails typed and atomically until delivery
  frees a slot. Warning outbox payloads freeze rule, reason, counterparty, currency and overdraft
  amounts at commit time. Delayed delivery never reconstructs copy from a later state; legacy rows
  without context use generic wording.

### 5.6 Деплой

Статический Vite build и bot runtime развёрнуты на выделенном Irena VPS под
`https://euphoria.bot`. Standalone stack использует immutable releases, atomic
`current`/`previous`, TLS/security headers, SPA fallback и read-only containers. `connect-src`
разрешает `https://api.frankfurter.dev`. Точная процедура находится в
`deploy/standalone/README.md`; generic remote Git pull для этого проекта неприменим. Live vhost
намеренно остаётся без HSTS: включать его можно только после owner acceptance в актуальных
Android/iOS Telegram clients. Hostinger сохраняется как отдельный TLS-valid rollback origin до
закрытия этого gate; DNS-failback на него в текущем цикле не репетировался.

Bot разворачивается отдельным immutable Node 22 image. Token устанавливается только через hidden
TTY prompt в root-owned `0600` file и bind-mount read-only; `.env`, argv и shell history его не
содержат. Container работает non-root, read-only, без capabilities и подключается к shared Nginx
через отдельную edge network без доступа к Mongo/data plane. Current live release publishes only
rate-limited `POST /api/tma/bootstrap`. The local authority candidate additionally defines signed,
rate-limited `bank-import`, `bank-command` and `bank-rates` routes; they are not production claims
until bridge activation. A mutation bypasses the per-user budget only after the exact operation ID
and canonical payload hash already exist in SQLite; invalid, conflicting or otherwise uncommitted
retries are charged. Committed domain failures are stored outcomes and replay with the exemption.
Polling and health remain private.

While `ledgerMode=local`, Telegram profile setup and `/help` expose only `/start`, `/settings`,
`/help` and `/privacy`; mutation commands are not advertised before authority. The one-way
`server --apply` path records the final durable switch event, restarts the current bot so startup
publishes RU/EN server command profiles, then requires 31 continuous healthy seconds plus TLS/API
smoke. A reconciliation run in an already-server database repeats the restart and gates without
changing ledger data.

Production target — выделенный Irena VPS (`ssh irena`, `/srv/cometa-bank`) со standalone
Compose edge: host Caddy один держит public `80/443`, Nginx публикует только loopback
`8080/8443`, а bot использует internal edge и отдельный egress. Перед первым source-clean bridge
extracted release A сначала запускает `install-docker-perimeter.sh` dry-run/apply. Installer
требует Docker Engine 28+, атомарно ставит canonical three-key `/etc/docker/daemon.json`, оставляет
единственный daemon host `-H fd://` и pinned local `/run/docker.sock`, затем делает один controlled
Docker restart с проверкой неизменных container IDs/restart counts, exact networks, SQLite и обоих
HTTPS boundaries. Root-only journal и exact `.pending.next`/`daemon.json.cometa-bank.next`
candidates позволяют продолжить только однозначный install/rollback; любой unknown или mixed state
fail closed. После этого candidate-owned `harden-edge --apply` target-scoped убирает Cometa TLS bypass из installed Caddy,
применяет host-wide Caddy policy `h1/h2` и добавляет exact trusted real-IP block в legacy Nginx;
unrelated Caddy route blocks сохраняются. Та же транзакция переводит Caddy admin с legacy
`127.0.0.1:2019` на caddy-owned Unix socket mode `0200`, ставит `persist_config off`, reload'ит через
текущий endpoint и сверяет live config с installed file. Strict preflight и каждый lifecycle gate затем проверяют
эти semantics, отсутствие UDP `443`, normal inner certificate trust с 21-дневным запасом и exact
runtime bindings и exact Compose-owned `bridge` topology. Edge hardening хранит original configs вне
process scratch, связывает их hashes с operator/current marker и блокирует остальные lifecycle actions
до verified commit или recovery. Activation и rollback перед парой symlink writes flush'ят durable
intent и fsync'ят directory после каждой rename; повторный запуск принимает только
before/between/complete link state, восстанавливает target runtime и завершает audit. Runtime contract
требует Docker Engine 28+, exact project identity, attached primary network, allow-listed bridge
options и пустой bot port map; rollback intent принимает только original-current operator.
Release tags привязаны к immutable image-ID manifests; deploy и Certbot renewal используют один
`flock`. Identical-source releases `20260902T233104Z` и `20260902T233133Z` независимо прошли
`pnpm verify`; второй активен, первый — automatic previous. Live D→C→D rollback rehearsal,
real systemd renewal и public HTTPS smoke пройдены без потери bot state и demo ledger. Старый
Hostinger vhost не выключается до Telegram Android/iOS acceptance и решения по внешнему rollback.

Renewal entrypoint и systemd units host-owned. Сам worker проверяется по root-owned record его
immutable source release и использует Compose contract оттуда, а не через `current`. Legacy upgrade
quiesce'ит timer persistent systemd guard'ом и journal'ом; signal/SIGKILL/power-loss recovery,
pending bundles, orphan containers и Docker metadata errors обрабатываются fail closed. Rollback
приложения сохраняет более новый проверенный worker.

## 6. Декомпозиция

Сквозное правило: browser-автоматизация не заменяет приёмку владельцем на реальном телефоне.
На 2026-09-02 Playwright и Computer View закрыли desktop/mobile viewport QA, а owner web pass принят.
Отдельно остаётся real Telegram WebView acceptance на Android/iOS.

- **M0 — Бутстрап.** Vite+React19+TS+Tailwind4+Vitest, токены (dark, oklch), Geist-probe
  (кириллица на specimen ДО вёрстки), platform-seam скелет (`*.web.ts`), ESLint-гард +
  CI-grep на `env(safe-area-inset-*)` вне tokens/viewport, ErrorBoundary, GitHub Actions
  (`test && build`).
  AC: verify зелёный; линт красный на нарочный `window.Telegram` в компоненте.
- **M1 — Домен и данные.** money/currency/interest/transfer/ledger + юнит-тесты + mutant-check (знак
  списания; `epochDayUTC` ±день; guard `days===0` — каждый мутант роняет именно свой тест, файл
  компилируется); four-account seed (2 KZT + USD + EUR); store+persist v4+migration+cross-tab;
  Frankfurter service,
  fallback/cache/date coherence; frozen FX snapshots; Web Lock serialization.
  AC: недостаток средств → отказ без мутации; own-transfer не меняет суммарный баланс; повторный
  settle в тот же UTC-день — 0 строк; 10 пропущенных дней — одна строка ровно за 10; перевод
  часов назад ничего не начисляет и не съедает; битый localStorage → видимый тост-сброс; два
  таба синхронны; dev-инвариант держится после каждой мутации.
- **M2 — Home + навигация.** Таб-бар (4, центр — Перевод), стейт-машина, useBackGesture,
  hero + count-up + APY-бейдж, демо-водяной знак, SettingsSheet.
  AC: на реальном телефоне ничего не обрезано notch/индикатором; count-up только на изменение;
  переключение счёта без мигания.
- **M3 — History.** Группировка, поиск, фильтр, связь ног own-transfer, пустое состояние.
  AC: поиск по «Пятёрочка» находит; 150 строк скроллятся без лагов на телефоне (виртуализация —
  только если замер покажет).
- **M4 — Cards.** Карусель scroll-snap + tilt, деталь-sheet, реквизиты + copy, freeze.
  AC: свайп нативный тачем и мышью; конфликт жестов scroll vs tilt разрешён (`touch-action`,
  раздельные состояния — red team №1); grep: полного номера нет нигде; freeze переживает reload.
- **M5 — Переводы.** Оба шита, валидация, идемпотентность, success-сцена, CTA за seam.
  AC: двойной быстрый тап не списывает дважды (explicit probe); недостаток средств — инлайн до
  сабмита; 5 переводов подряд сходятся с ручным расчётом; успех виден в History сразу;
  кросс-валютный перевод создаёт две ноги с одинаковым проверяемым FX snapshot.
- **M6 — Полировка.** Движение, копирайт-проход (RU-голос), ревью правдоподобия сида, кастомные
  иконки, a11y-гейт (контраст AA — заложить несколько раундов: приглушённый дарк почти всегда
  проваливает AA на вторичном тексте с первой попытки; тач-таргеты ≥44px; фокус), скриншот-QA
  Playwright [320/390/460/700/900] против чек-листа AI-дефолтов.
  AC закрыт: Playwright/Computer View и a11y-чеклист зелёные; владелец проверил live web app
  на телефоне и подтвердил внешний вид и работу. Real Telegram WebView остаётся отдельным M8 gate.
- **M7 — Hostinger + `euphoria.bot`.** Префлайт текущего vhost, атомарный deploy, TLS/security headers,
  external smoke и Lighthouse mobile. AC закрыт: apex live, canonical redirects, SPA/assets/API,
  17/17 shared-proxy SNI, renewal cycle и rollback проверены; repeated Lighthouse mobile 96/100/100
  (SEO 63 намеренно из-за noindex).
- **M8 — TMA-порт (фаза 2).** `adapter.telegram.ts` (тема/haptics/кнопки за
  существующими call-site), BackButton lifecycle (show при открытом sheet, hide на корне),
  bindCssVars на нейтрали только для dark host; light host оставляет brand-safe base (AC: CTA и
  бренд-акценты читаемы в обеих Telegram-темах),
  initData валидируется bot backend. Init использует rolling retry budget 12 стартов/5 минут,
  30-секундный cooldown для visibility/online signals, identity-isolation-aware 4.5-секундный splash
  deadline, `ready()`/expand one-shot, а late-mounted Main/Back controls
  получают последний config/handler. Bootstrap receipt связывает Telegram user, BankState schema,
  revision и server-generated revision epoch, поэтому новый DB не проигрывает старому локальному
  revision. TMA persistence остаётся ephemeral до server verification и после него связывает
  bank/locale/receipt с canonical per-user namespace. Bot использует exact update-ID dedupe с
  шестидневным sequence reset, durable reply
  outbox с per-row backoff и shutdown-aware Bot API requests; его health зависит от polling, а не
  от доставки отдельного reply. Код адаптера, bot onboarding/bootstrap infrastructure, BotFather
  binding, Irena activation, подписанный Telegram Desktop bootstrap и автотесты готовы; остались
  полный RU/EN bot-onboarding, rotation owner-authorized exposed test token до нетестового
  использования и приёмка в реальном Telegram WebView на Android/iOS. Опция
  кросс-девайс: CloudStorage за тем же persistence seam.
- **M9 — Multi-user demo ledger.** Eight base-currency fixtures, persistence v5, shared typed bank
  commands, per-Telegram-ID SQLite authority, one-time canonical import, bot transaction/recurrence
  and account-management wizards, reversible close/restore, atomic UTC backfill and no-overdraft.
  The implementation candidate is local; it is not active in production. Rollout requires two
  authority-capable releases under local mode, a guarded one-way server switch, two-profile Telegram
  acceptance and three real README captures. Offsite backup/restore drill and epoch-ordered disaster
  recovery remain separate follow-ups.

Первый release bridge выполняется строго в порядке: package/extract source-identical A/B →
`install-docker-perimeter.sh` dry-run/apply из A → `release.sh harden-edge` dry-run/apply из A →
strict preflight A/B → prepare A/B → activate A/B при `ledgerMode=local`. На 2026-09-06 ни один из
этих candidate steps на Irena не запускался; production остаётся на прежнем device-local baseline.

Точное текущее verification evidence и история independent review живут в `docs/handoff.md`, чтобы
цифры не расходились между документами. Обязательные механизмы здесь: focused behavior tests,
compiling named mutants для domain/state изменений, полный `pnpm verify`, browser-emulation и
отдельный real Telegram WebView pass. Последний нельзя заменить unit/Playwright тестами.

## 7. Риски (включая выжившие удары red team)

| Риск | Митигация |
|---|---|
| Дизайн скатывается в generic (Inter/purple/шаблон) ИЛИ в «чёрный+золото»-клише | Монохром+минт; чек-лист AI-дефолтов на скриншот-QA; кастомные иконки; копирайт-проход |
| Крэш/битое состояние на живом показе | ErrorBoundary + migration-reset с тостом (M0/M1, не постфактум) |
| Двойное списание | clientTransferId ring-buffer + disable-on-click + HTTP-safe `getRandomValues` generator + explicit M5 probe |
| Рассинхрон баланса и истории | Структурно невозможен (ledger-derived) + dev-инвариант |
| Два concurrent-перевода из разных вкладок теряют одну мутацию | Exclusive Web Lock + перечитывание persisted state внутри lock; rejected acquisition деградирует в single run только в том же namespace, account switch abort'ит stale work; two-page + restricted-lock probes |
| Quota/private-mode write откатывает уже успешную in-memory мутацию | Failed write включает in-memory-authoritative mode; stale persisted state/events игнорируются до успешной записи |
| Persisted ID резервирует будущий `tx_N`/`grp_N` и ломает следующую запись | Schema v4 требует canonical `tx_${seq}` и связывает runtime group с seq исходящей ноги |
| Обезличенная выписка всё равно fingerprintable по датам, merchants и суммам | PII и identifiers удалены; риск явно указан в README/handoff. Для публичного шаринга нужен отдельный shifted/synthetic fixture |
| Устаревший/частичный FX payload искажает конверсию | Bounded UTC range, последний полный same-date exact quote set, лаг ≤7 UTC-дней, атомарный reject и fallback |
| TMA подменяет provider rates или создаёт request storm | TMA sends only a signed refresh intent; backend owns bounded parsing, coherent adoption, one process-wide 12-hour cache, 30-second failure cooldown, in-flight dedupe and a non-replayable refresh budget |
| Исторический FX «плывёт» после refresh rates | Immutable `fxSnapshot` на обеих ногах + persistence-реконструкция курса |
| Часы устройства/DST ломают проценты или отклоняют свежий server snapshot | epochDayUTC + max(0,…); canonical state валидируется по exact response `serverTime`, а device clock используется только как 24-hour corruption bound |
| Порт TMA «дни → недели» | Seam + ESLint-гард + CSS-grep; без роутера; CTA/back за seam с M2/M5 |
| Late Telegram bridge монтирует native control без action/config | Desired Main/Back state хранится в adapter и replay после успешного mount; bounded retry regression |
| Telegram SDK снова меняет API | Maintained `@tma.js/sdk-react` pinned exact; platform seam изолирует SDK, adapter tests + real WebView gate обязательны перед bump |
| Подмена или stale Telegram preferences после пересоздания DB | Raw initData проверяется backend HMAC/freshness; frontend принимает exact versioned projection и связывает receipt с canonical Telegram ID + server revision epoch |
| Signed bootstrap loop превращает read path в SQLite DoS | Separate authenticated 30/min budget per Telegram ID runs before user/bank lookup and has no replay exemption |
| Signed mutation body обходит limiter дорогим parsing/hash | Import and command ingress budgets run after HMAC but before body read/canonicalization; exact durable replay bypasses only the inner mutation budget |
| Parsed SDK user отстаёт после смены Telegram account | Raw-session fingerprint открывает новый identity epoch и quarantine до verified bootstrap; obsolete sync не может переоткрыть старый namespace |
| Два Telegram-аккаунта на одном origin читают/перезаписывают общий mock ledger | Ephemeral pre-verification quarantine + canonical per-ID bank/locale/receipt namespaces; exact-key storage listeners; same-ID dirty state остаётся authoritative |
| Telegram рандомизирует `update_id` после долгого простоя | Exact-ID dedupe + persisted timestamp; после шести суток без update sequence offset сбрасывается перед long poll |
| Недоставленный custom-name reply останавливает весь bot | Atomic preference+outbox mutation; per-row retry/backoff после успешного poll; один reply не влияет на readiness и не блокирует следующие строки |
| Wizard сохранил step, но crash потерял prompt, либо prompt ушёл до processed marker | Session + conversation reply receipt commit atomically; independent delivery/processed state covers both crash orders and bounded retention prevents an orphan from living forever |
| Operation ledger grows without bound or capacity blocks recovery | 8,192-row sliding replay window; prune the oldest completed row transactionally, protect pending outbox, and keep import/system materialization outside the user window |
| Invalid retry бесплатно обходит mutation limiter | Exemption consults the exact persisted `(user, source, operation ID, canonical hash)`; invalid, conflicting and otherwise uncommitted attempts are charged again, while a committed domain failure replays its stored outcome |
| Delayed warning describes a reset or edited rule | Warning outbox freezes rule/reason/counterparty/currency/amount context at commit; legacy rows render generic copy |
| Bot read показывает recurrence без начисленного savings interest либо дублирует UTC-day rows | One canonical locked materializer always runs `applySettleAll` before recurrence and is same-day idempotent across bootstrap/chat reads |
| Deploy обрывает Bot API request или длинный `retry_after` | Один worker `AbortSignal` отменяет handler, send/callback/menu fetch и sleep внутри Compose shutdown grace |
| Ambient Docker context или daemon API расширяет host boundary | Все release calls pin `/usr/bin/docker`, empty CLI config и `/run/docker.sock`; one-time installer требует единственный systemd `-H fd://`, exact daemon JSON, Docker 28+ и durable fail-closed recovery |
| Caddy autosave/TCP admin расходится с installed edge | `persist_config off`; caddy-owned Unix admin socket mode `0200`; reload через текущий endpoint; live canonical config обязан совпасть с installed Caddyfile |
| App rollback откатывает recovery-логику Certbot или renewal падает в crash-window | Host-owned worker привязан к recorded immutable release; persistent systemd guard/journal; `--recover-only`; pending/orphan/Docker metadata gates fail closed |
| Утечка bot token | File-only service-owned secret, hidden prompt, redacted logs, container read-only; token из chat запрещён для нетестового использования. Текущий owner-authorized test exception явно tracked и обязан быть revoke/rotate до public/non-test launch |
| bindCssVars съедает бренд-акцент или контраст в light host | Только dark-host нейтрали; light host оставляет brand-safe base; явный AC в M8 |
| Форма продукта ≈ скам-паттерн FEMITBOT; имя ≈ Kaspi | Бренд «Cometa» по умолчанию (§8); постоянный демо-знак; запрет countdown; disclaimer-текст; гейт перед публичным релизом включает репо и домен, не только APP_NAME; запасное имя наготове |
| Дисклеймер как митигация модерации — недоказан (UNVERIFIED источника) | Делаем всё равно (снижает вероятность жалобы), но не считаем гарантией; формальные правила Telegram для fin-категории проверить перед публичным релизом |
| Tilt поверх scroll-snap — конфликт жестов | Заложен в AC M4 с механизмом (touch-action, состояния), не «одна строка кода» |
| Приглушённый дарк проваливает AA-контраст | Несколько раундов ручной проверки заложены в M6 явно |
| localStorage-объём при разросшемся сиде | Probe на 300-500 строк при первом расширении сида |
| iOS TMA чистит localStorage | Фаза-2-риск; решается за persistence-seam (CloudStorage/бэкенд), зафиксировано, не забыто |
| Shared proxy/TLS lifecycle ломает соседние vhost | Приватный полный backup, bootstrap→maintenance→final gates, `nginx -t` перед каждым reload, 17/17 SNI probe и единственный serialized systemd owner |

## 8. Открытые вопросы владельца (работаем с дефолтами, финальное слово — его)

1. **Бренд.** Дефолт — «Cometa» (личный бренд NikitaCometa, ноль коллизии с Kaspi, домены
   владельца вероятно созвучны). «Kaspy» оставлен только в имени директории репо; если владелец
   хочет его в UI — риски в §7 усиливаются.
2. **Деплой.** Authoritative `euphoria.bot` работает с Irena; ACME, D→C→D app rollback и renewal
   зелёные. Hostinger временно остаётся TLS-valid external rollback origin, но DNS-failback на него
   не репетировался. Demo намеренно noindex и без HSTS; вывод Hostinger, HSTS и публичная индексация
   ждут owner acceptance в актуальных Android/iOS Telegram clients и явного одобрения public launch.
3. **Акцентный цвет** — минт-дефолт; токен, замена дёшева. Red team просил явно подтвердить у
   владельца перед вёрсткой.
4. **Светлая тема** — не архитектурный вопрос (токены готовы), продуктовый: нужна ли вообще.
5. **Request money / входящие переводы** — вне скоупа, добавлять ли потом.
6. **Кросс-девайс демо** — resolved for authenticated Telegram identities by server authority;
   anonymous web remains intentionally device-local.
7. **Устройство демо** (iOS Safari vs Android Chrome) — куда смотреть в первую очередь на M6.

## 9. Приложение: вклад и артефакты

- **Track A (Claude, xhigh):** ledger-derived баланс; MainButton/CTA-seam; RU-валюта из брифа
  (снял выдуманный KZT-вопрос); отказ от Router по TMA-мотиву; мотивированное несогласие с Dexie.
- **Track B (Claude contrast MVP-first + robustness-критик; Sol недоступен — обёртка codex не
  увидела staged-файлы в scratchpad, при квоте 98% ретраи не делались):** чистая формула процентов,
  epochDayUTC, clientTransferId≠transferGroupId, ErrorBoundary, migration/reset, ESLint-гард,
  4-таба навигация, холодная база (дистанция от Ember Neon), storage-event sync.
- **Ресёрч (5 линз):** канон необанков, вердикт «с нуля быстрее», версии по npm view, TMA-грабли,
  FEMITBOT-риск, анти-slop типографика/цвет.
- **Red team:** 19 находок (0 kill-shot) — gold-клише, иконки/копирайт как slop-поверхность,
  bindCssVars-угроза, env() мимо линта, репо/домен в гейте бренда, конфликт жестов tilt.
- **User-lens:** реквизиты в модели, поиск в History, видимый APY, связь ног перевода,
  success-сцена, сортировка контактов, реалистичное время сида.
- **Implementation delta 2026-09-01:** после исходного брейншторма владелец расширил скоуп до
  восьми валют. Канон выше уже включает currency domain, live rates, frozen FX, Web Locks,
  Telegram adapter, generated badges, local fonts и Hostinger→Irena migration для `euphoria.bot`;
  исходные research-артефакты эти
  поздние решения не отражают.
- Ключевые артефакты рана скопированы в `docs/research/` (digest, redteam, lens-user,
  lens-completeness, context-packet, оба v2-плана, mission-brief); сырые v1 и research/*
  остались в scratchpad сессии 2026-09-01 и умрут вместе с ней.
