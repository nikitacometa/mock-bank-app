# Digest: research pack для Kaspy (mock-необанк, web → TMA)

Дата всех источников — 2026-09-01 (если не указано иначе). Формат: факт → источник(ы). `UNVERIFIED` — маркер сохранён из исходных файлов.

---

## Линза 1: UI/UX эталонных необанков (neobanks.md)

**Канон жанра — 5 сходящихся паттернов у Revolut/Monzo/N26/Wise/Т-Банк:**
1. Баланс крупно наверху + переключатель счетов сразу под ним. Источники: [Revolut blog](https://www.revolut.com/blog/post/meet-pockets-the-next-evolution-of-vaults), [Monzo — new Home screen](https://monzo.com/blog/the-new-and-improved-home-screen), [jonnyczar.com N26 case study](https://www.jonnyczar.com/project/n26).
2. «Копилка»/суб-счёт — первоклассный визуальный объект, отдельный от перевода. При этом жанр в 2025 **явно разводит** «цель без дохода» и «продукт с процентом» на два разных места UI: Revolut Pockets (цели) vs Savings (доход, партнёр-банк Cross River с 29.07.2025); Monzo Pots vs interest-bearing Pots вынесены в раздел «Savings & Investments». Источники: [Revolut blog](https://www.revolut.com/blog/post/meet-pockets-the-next-evolution-of-vaults), [Monzo community thread](https://community.monzo.com/t/app-evolution-new-look-monzo-app-feedback-megathread/141702).
3. Транзакции: реальный мерчант-лого + чистое имя вместо «зашифрованных» банковских кодов, группировка по дате. N26 redesign прямо заменил raw-имена на логотипы мерчантов. Источник: [jonnyczar.com](https://www.jonnyczar.com/project/n26).
4. Карта — управляемый в приложении объект (freeze, лимиты, PIN, кастомизация дизайна), не физический артефакт. Cash App: «Design a new card» прямо из таба карты. Источник: [Cash App Help](https://cash.app/help/us/en-us/11081-re-design-a-cash-card).
5. Тёмная тема — переключаемая, не единственная; бренд-цвет требует ручной адаптации под dark mode, не автоинверсии. Т-Банк — ручной тоггл, дефолт светлый ([tbank.ru](https://www.tbank.ru/finance/blog/inclusive)). Nubank осознанно делал фирменный фиолетовый светлее в dark mode вместо инверсии ([Nubank Building blog](https://building.nubank.com/the-birth-of-the-dark-mode-a-journey-into-nubanks-app-evolution)).

**Wise — единственный банк с детальным тирдауном send-флоу:** 8–10 экранов, намеренно раздроблен (один вопрос на экран — откуда/куда/цель/сумма разнесены), хотя технически влезло бы в один. Источник: [Medium/UX Collective](https://medium.com/design-bootcamp/5-things-users-care-about-in-payment-transfer-app-ux-2d534d28b2c6).

**N26 — жестовый паттерн:** swipe по строке транзакции даёт быстрое действие (зарплата → в Space; трата → пополнить со Savings). Источник: [jonnyczar.com](https://www.jonnyczar.com/project/n26).

**Kaspi.kz — контекст для бренда «Kaspy».** Kaspi — суперапп (маркетплейс + госуслуги + Kaspi Pay эквайринг + банкинг), 16 млн активных пользователей, не узкий необанк. Продуктовый риск: скоуп Kaspy (2 счёта + история + карты + переводы) функционально ближе к Monzo/Revolut/N26, а название намекает на Kaspi — риск ожидание/продукт mismatch у казахстанской аудитории. Источники: [Kaspi IR](https://ir.kaspi.kz/about/mobile-app), [Google Play](https://play.google.com/store/apps/details?id=kz.kaspi.mobile&hl=ru).

**Telegram Wallet — прямой референс для фазы 2 (TMA-порт).** Ключевой паттерн — «no-app UX»: Mini App открывается инлайново внутри чата, тема/навигация подхватываются от хоста, онбординг минимален (custodial/non-custodial через TON Space, MPC/passkeys под капотом, без явного управления seed-фразой). Источники: [TradersUnion review](https://tradersunion.com/best-crypto-wallets/telegram-wallet), [Peiko dev guide](https://peiko.space/blog/article/telegram-crypto-wallet-development-guide).

**UNVERIFIED в этой линзе:** детальные тирдауны транзакционных списков/карт Revolut, структуры экранов Cash App/Nubank/Kaspi/Т-Банка — не найдено надёжных первоисточников в рамках бюджета поиска (только вторичные дизайнерские разборы или маркетинг-страницы).

---

## Линза 2: Open-source prior art (opensource.md)

**Вердикт исходного ресёрча: ничего не брать целиком.** Найденные репо — либо большие dashboard-шаблоны с лишним скоупом (crypto/investments/budgets, Clerk-auth), либо учебные проекты без премиального дизайна, либо B2B compliance-инфраструктура.

**Точечно полезное:**
- `@faker-js/faker` — npm v**10.6.0**, MIT, живой (проверено `npm view` 2026-09-01) — `faker.finance`/`faker.commerce` для сидирования мок-транзакций/мерчантов.
- [`abderrahimghazali/shadcn-fintech`](https://github.com/abderrahimghazali/shadcn-fintech) — 76★, Next.js 16 + shadcn/ui + Tailwind v4, MIT. Покрывает Accounts/Transactions/Transfers/Cards (3D flip, freeze, virtual card creator), но зашито в 11-страничный desktop-dashboard (crypto/investments/budgets — вне скоупа), эстетика не «mobile-first премиум 2026». Смотреть точечно `src/data/seed.ts` и cards-компонент, не форкать.
- [`cenksari/react-banking-app-template`](https://github.com/cenksari/react-banking-app-template) — MIT, покрывает по названиям экранов весь скоуп (Signin/Home/Transactions/Cards/Add Money/Savings), но дизайн по скриншотам — обычный shadow-card стиль, не 2026-премиум. Полезен только как список флоу.
- `@telegram-apps/sdk-react` — npm v**3.3.9** (проверено `npm view`), для фазы 2.
- [`Telegram-Mini-Apps/nextjs-template`](https://github.com/Telegram-Mini-Apps/nextjs-template) — 369★, 123 forks — референс структуры подключения SDK, не банковского функционала.

**UNVERIFIED:** лицензии `@telegram-apps/sdk-react` и `@tonconnect/ui-react` (версии подтверждены `npm view`, тексты лицензий не читаны); точное имя репо из `github.com/topics/neobank` с «181-operation banking API» не открывалось напрямую; `nearform/open-banking-reference-app` не исследован глубже сниппета.

---

## Линза 3: Telegram Mini Apps платформа (tma.md)

**SDK:** `@telegram-apps/sdk` — версия **3.11.8** на странице npm (Snyk-таблица патчей подтверждает 3.11.8 от 8 Oct 2025), React-биндинги `@telegram-apps/sdk-react` v**3.3.9**. Источники: [npmjs.com](https://www.npmjs.com/package/@telegram-apps/sdk), [Snyk](https://security.snyk.io/package/npm/%40telegram-apps%2Fsdk). Позиционируется авторами как замена официальному `telegram-web-app.js` («does not meet required minimum quality standards» — цитата самих авторов конкурирующего пакета, не независимо верифицирована).

**initData auth:** сырой `initData` валидируется на бэке HMAC-SHA256 (`HMAC-SHA256("WebAppData", bot_token)` как секрет, затем HMAC от отсортированной data-check-string); `initDataUnsafe` доверять нельзя. Новая альтернатива 2026 — Ed25519-подпись (поле `signature`), позволяет сторонним сервисам проверять без доступа к токену бота. Источники: [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps), [aunimeda.com guide](https://aunimeda.com/blog/how-to-build-telegram-mini-app-2026). Анти-паттерн из живого примера (Rust/Axum): валидация обходится в dev-режиме «для удобства» — риск забыть выключить в проде.

**Viewport/safe area грабли:**
- `100vh` вместо `var(--tg-viewport-height)` → контент уезжает под fold в bottom-sheet режиме открытия.
- `viewportHeight` вместо `viewportStableHeight` → layout прыгает при появлении клавиатуры.
- Открытый баг на iOS: авто-подстройка под клавиатуру работает некорректно (платформенное ограничение).
- Живой открытый баг (issue #86, Aug 2026, Telegram 12.9.2, Android): WebView сам перезагружается каждые несколько секунд — на дату доступа не починен.
- `safeAreaInset` (системные зоны — notch/home indicator) и `contentSafeAreaInset` (зона, занятая UI Telegram) — два разных инсета.
Источники: [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps), [adsgram.ai grabli-статья](https://adsgram.ai/blog/adsgram/telegram-mini-app-tma-development-mistakes-and-how-to-avoid-them), [GitHub issues](https://github.com/Telegram-Mini-Apps/issues/issues).

**themeParams:** темы (Day/Night, кастомные клиентские) приходят в реальном времени; `themeParams.mount()` + `.bindCssVars()` в SDK прокидывает их в CSS-переменные автоматически. Источник: [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps).

**Нативные элементы:** MainButton/SecondaryButton/BackButton/SettingsButton/HapticFeedback (методы HapticFeedback чейнятся). `enableClosingConfirmation()` (Bot API 6.2+), `enableVerticalSwipes()` (Bot API 7.7+, рекомендуется включать по умолчанию если не конфликтует с жестами приложения). Источник: [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps).

**Хранилище:** `localStorage` — известный баг «blank screen on iOS» из-за очистки при потере сессии → рекомендация переносить сессию на бэкенд, не полагаться только на localStorage. `CloudStorage` — до 1024 items на пользователя/бота, синхронизируется через сам Telegram. `DeviceStorage`/`SecureStorage` заявлены в Bot API 9.0, точная семантика `UNVERIFIED`.

**🔴 Риск модерации — прямое пересечение с формой продукта Kaspy.** Задокументированная (CTM360, отчёт FEMITBOT, май 2026) мошенническая инфраструктура именно в форме Mini Apps с «fake dashboards that display fictional balances or earnings» + countdown-таймерами, мимикрирующими под известные бренды. Прямая цитата: «Victims are often shown fake dashboards that display fictional balances or earnings, enhanced by countdown timers to create urgency.» Источники: [dataconomy.com](https://dataconomy.com/2026/05/04/telegram-mini-apps-abused-in-large-scale-crypto-scam-campaign), первоисточник [CTM360 report](https://www.ctm360.com/reports/femitbot-telegram-mini-apps-fraud-campaigns). Модерация Mini Apps описана как реактивная (по жалобам) — [Kaspersky blog](https://www.kaspersky.com/blog/telegram-mini-app-phishing/55041), но `UNVERIFIED` детектит ли Telegram такие паттерны превентивно. Митигейшены из ресёрча: явный disclaimer в UI («демо, не настоящий банк»), не запрашивать реальные платёжные/KYC данные, не использовать countdown-таймеры на «начислениях», развести брендинг с Kaspi по названию/визуалу.

**Официальный чеклист архитектурной готовности к порту** (синтез раздела 12 tma.md, 13 пунктов) — сквозная тема: абстракция над платформенными вызовами, CSS через переменные, тема токенами, safe-area с первого дня, навигация без браузерного «назад», CTA-кнопка внизу как аналог MainButton, auth-контракт с точкой входа `getCurrentUser()`, storage за абстрактным слоем, устойчивость к ремаунту (Android-баг #86), `isSupported()`-гварды.

---

## Линза 4: Технический стек (stack.md)

Версии — прямой `npm view <pkg> version`, 2026-09-01.

| Слой | Выбор | Версия |
|---|---|---|
| Фреймворк | React 19 + Vite | react 19.2.8, vite 8.2.2 |
| CSS | Tailwind CSS v4 | 4.3.3 |
| Анимации | motion (LazyMotion + domAnimation) + CSS | motion 13.1.1 |
| Стейт (UI) | Zustand | 5.0.15 |
| Данные | Dexie.js (IndexedDB) | 4.4.5 |
| Бэкенд фаза 1 | нет (чистый клиент) | — |
| Бэкенд фаза 2 | Hono на Cloudflare Workers | hono 4.13.5 |
| Деплой | Cloudflare Pages | — |
| TMA SDK (фаза 2) | @telegram-apps/sdk-react | 3.11.8 |

**React vs Svelte 5 — выбор НЕ по перформансу.** Svelte быстрее (production-бандл ~47KB vs React ~156KB, рендер 1000 элементов 8-11мс vs 28-47мс) и выигрывает Stack Overflow "most admired" (71% vs 61%), но `@telegram-apps/sdk-react` — единственный зрелый SDK под TMA, все найденные production-примеры на React. Решающий фактор — риск на самом рискованном участке брифа (порт в TMA), не производительность мок-банка с 2 счетами. Источники: [strapi.io comparison](https://strapi.io/blog/svelte-vs-react-comparison), [pkgpulse.com](https://www.pkgpulse.com/guides/vue-3-vs-svelte-5-2026).

**Tailwind v4** — «still the safest default for most teams in 2026» ([kanopylabs.com](https://kanopylabs.com/blog/panda-css-vs-tailwind-v4-vs-vanilla-extract)), Rust-движок (Oxide), полные ребилды <100мс, конфиг в CSS-нативных `@theme`. Contrarian voice: [morello.dev](https://morello.dev/blog/replacing-tailwind-with-vanilla-css) снял Tailwind с личного блога в пользу vanilla CSS (cascade layers/`:has()` уже закрывают тот же кейс) — валидно для простого статического сайта, не для приложения с AI-ассистированной генерацией UI-кода.

**Dexie.js поверх IndexedDB, не localStorage.** Причины: транзакции критичны для домена (перевод между счетами должен быть атомарным), персистентность между сессиями (демо-показы на телефоне), `useLiveQuery` снимает дублирование данных в Zustand. Источники: [dexie.org](https://dexie.org), [pkgpulse.com storage guide](https://www.pkgpulse.com/guides/dexie-vs-localforage-vs-idb-indexeddb-browser-storage-2026).

**Деплой — Cloudflare Pages** предпочтён Vercel/Netlify: безлимитный bandwidth на free-тире, Vercel Hobby **явно запрещает коммерческое использование в ToS** ([puter.com blog](https://developer.puter.com/blog/cloudflare-pages-alternatives)) — блокер задним числом если проект вырастет; тот же провайдер что и планируемый Hono-бэкенд фазы 2.

**Расхождение источников (явно зафиксировано в stack.md):** цифра лимита custom domains у Cloudflare Pages — один источник ([digitalapplied.com](https://www.digitalapplied.com/blog/vercel-vs-netlify-vs-cloudflare-pages-comparison)) даёt «100 per project», три остальных источника — «unlimited». Не переисследовано, для одного домена pet-проекта не критично.

**UNVERIFIED:** Supabase free tier лимиты 2026 не проверялись отдельным поиском; Bun как рантайм фазы 2 не сравнивался напрямую с Workers; SolidJS+Telegram — вывод «не рекомендую» сделан от отсутствия позитивной находки (открытый домен, не полный перебор).

---

## Линза 5: Дизайн-тренды финтеха 2026 (design2026.md)

**Типографика — Inter уже не премиальный дефолт, а маркер AI-slop.** Три независимых источника называют связку «Inter + purple gradient + 3 карточки» фингерпринтом генерик-дизайна: [925studios.co](https://925studios.co/blog/ai-slop-design-tells), [prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website), [Hacker News #46475531](https://news.ycombinator.com/item?id=46475531). Альтернативы: платные Söhne/GT America/Aeonik, бесплатные General Sans, **Geist** (Vercel, «85% match для Söhne» — [fontalternatives.com](https://fontalternatives.com/compare/sohne-vs-geist)), Switzer, Mona Sans. Рекомендация ресёрча: Geist + Geist Mono/tabular-nums для чисел.

**tabular-nums — практическая необходимость, не эстетика.** Без `font-variant-numeric: tabular-nums` цифры «прыгают» по ширине при count-up анимации баланса. Источник: [Framer marketplace docs](https://www.framer.com/marketplace/components/formatted-counter).

**Цвет:** тёмная тема как дефолт у топ-необанков (Revolut/Monzo/N26/Chime класс), монохром + один сигнатурный акцент — паттерн карт (N26 аква, Nubank фиолетовый, Wise зелёный). Источники: [saasfactor.co](https://saasfactor.co/blogs/fintech-mobile-app-design), [fintechbranding.studio](https://fintechbranding.studio/fintech-card-design-trends). ⚠️ Фиолетовый двусмысленен — «премиум» в классической номенклатуре брендинга, но indigo/purple-градиент отдельно назван AI-slop-фингерпринтом (см. ниже) — рекомендация избегать дефолтного Tailwind indigo-500.

**Глубина:** flat/minimal как база, glassmorphism жив и используется точечно (не neumorphism — тот прямо назван «cautionary tale» 2020 года, [setproduct.com](https://setproduct.com/blog/liquid-glass-vs-glassmorphism)). Рекомендация: soft-glass только на hero-элементе (карточка баланса/карта), не на весь интерфейс.

**Движение:** spring-физика — стандарт для интерактивных элементов (drag/press/hover/layout), easing-кривые — для предсказуемого таймина (progress bars). Skeleton-состояния обязательны, не опциональны, наравне с payment-success анимацией и card-freeze confirmation. Источники: [motion.dev](https://motion.dev), [lollypop.design](https://lollypop.design/blog/2026/june/banking-app-ui-design).

**Навигация:** bottom sheets вытесняют модалки и топ-навигацию — консенсус нескольких источников про «thumb zone». Прямая цитата ([zealousys.com](https://zealousys.com/blog/top-mobile-app-ui-ux-design-trends)): «Applications that force users back into tap-only navigation while the surrounding OS uses gestures create a jarring inconsistency that reads as a design regression». Главный экран = баланс + последняя транзакция первым экраном, всё остальное на уровень глубже ([orbix.studio](https://orbix.studio/blogs/banking-app-ux-design-guide)).

**Anti-patterns AI-slop (сведено из 3+ независимых источников):** Inter/Roboto как единственный шрифт, indigo→purple градиент (происхождение — исторический Tailwind-дефолт `indigo-500`, `UNVERIFIED` — сама цитата извинения создателя Tailwind взята со слов вторичного источника, твит не проверялся напрямую), три одинаковые feature-карточки, центрированный hero+CTA, одинаковые скругления везде, тени 0.1 opacity без смысла, neumorphism, playful яркая палитра без сдержанного акцента.

**TMA-архитектурное требование к теме (design2026.md, раздел 7):** «Do not ship a separate light and dark palette; let the host theme drive a single semantic token set» — семантические CSS-переменные (`--color-bg`, `--color-accent` и т.п.) с первого коммита, перепривязываемые к `themeParams.bindCssVars()` в фазе 2, а не два хардкод-набора цветов. Источник: [vp0.com](https://vp0.com/blogs/telegram-mini-app-react-ui-components).

---

## Противоречия источников

1. **Cloudflare Pages custom domains лимит.** `digitalapplied.com` даёт «100 per project», три других источника (`pressless.io`, `exceltic.dev`, `danubedata.ro`) — «unlimited». Не критично для проекта с одним доменом, не переисследовано (stack.md, раздел 8).
2. **Tailwind weekly downloads.** Один источник — 25M/неделю, LogRocket — «over 12 million». Порядок величины (десятки млн) сходится, точная цифра — нет (stack.md, раздел 2).
3. **GSAP bundle size.** Один источник даёт ~69KB minified, другой — ~23KB; методика замера не выяснена (stack.md, раздел 3).
4. **Позиция «indigo-500 = извинение создателя Tailwind».** Взята со слов вторичного источника (925studios.co со ссылкой на пост в X), первоисточник не открывался — риторически убедительно, но не независимо подтверждено (design2026.md, раздел 6).
5. **Цветовая семантика «фиолетовый».** Один кластер источников относит фиолетовый к «премиум/инновации» в классическом брендинге (shadowdigital.cc), другой независимый кластер называет indigo/purple-градиент буквальным маркером AI-slop дешёвого дизайна (925studios.co, prg.sh, HN). Оба верны в своих контекстах (насыщенный акцентный фиолетовый vs generic indigo-gradient-на-белом), но дают противоположные сигналы при поверхностном чтении — нужно различать паттерны, не цвет как таковой.

---

## Явные дыры в данных (сведено по всем 5 файлам)

- Детальные UI-тирдауны главных экранов Cash App, Nubank, Kaspi.kz, Т-Банка, Telegram Wallet — не найдено надёжных первоисточников (только маркетинг-страницы/сторонние Dribbble-инспирации).
- Mobbin.com недоступен без подписки — не использован как источник скриншотов необанков.
- Точное имя и содержимое репо `github.com/topics/neobank` с «181-operation banking API» — не открывалось напрямую.
- Лицензии `@telegram-apps/sdk-react` и `@tonconnect/ui-react` — версии подтверждены, тексты LICENSE не читаны.
- Supabase free tier 2026, Bun как рантайм для фазы 2 — не исследовались отдельным поиском.
- `DeviceStorage` vs `SecureStorage` vs `CloudStorage` — точная семантика различия не проверена.
- Существование прецедентов бана/блокировки Telegram демо-банковских Mini Apps — не найдено (риск-оценка в tma.md — синтез из общих ToS-принципов + паттерна мошенничества FEMITBOT, не из явного правила или прецедента).
- Проактивно ли Telegram детектит паттерн «fake balance dashboard» (в отличие от реактивной модерации по жалобам) — не подтверждено ни в одну сторону.

---

## Сквозные выводы

1. **Архитектура «два типа накопительного счёта» (цель vs доходный продукт) — сходящийся паттерн 2025 у Revolut и Monzo независимо**, стоит закладывать в модель данных Kaspy сразу, даже если UI сначала объединённый. [Revolut blog](https://www.revolut.com/blog/post/meet-pockets-the-next-evolution-of-vaults), [Monzo community](https://community.monzo.com/t/app-evolution-new-look-monzo-app-feedback-megathread/141702).
2. **Тема — семантические CSS-переменные с первого коммита, не два хардкод-набора цветов.** Прямое архитектурное требование под TMA-порт (`themeParams.bindCssVars()` в фазе 2 просто перепривязывает переменные). [vp0.com](https://vp0.com/blogs/telegram-mini-app-react-ui-components), [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps).
3. **React выбран не за перформанс, а за единственный зрелый TMA SDK** (`@telegram-apps/sdk-react` v3.3.9/3.11.8) — Svelte быстрее и легче, но не имеет готовых Telegram-биндингов. [npmjs.com](https://www.npmjs.com/package/@telegram-apps/sdk-react), stack.md раздел 1.
4. **Dexie/IndexedDB вместо localStorage обязателен из-за атомарности переводов** (транзакции между счетами) и известного iOS-бага очистки localStorage в TMA WebView. [dexie.org](https://dexie.org), [adsgram.ai](https://adsgram.ai/blog/adsgram/telegram-mini-app-tma-development-mistakes-and-how-to-avoid-them).
5. **Explicit disclaimer в UI — не опция, а митигейшен задокументированного риска.** Форма продукта (мок-баланс, история операций, накопительный счёт) визуально неотличима от паттерна мошеннических Mini Apps FEMITBOT (май 2026, CTM360). [dataconomy.com](https://dataconomy.com/2026/05/04/telegram-mini-apps-abused-in-large-scale-crypto-scam-campaign).
6. **Название «Kaspy» несёт двойной риск** — юридическое сходство с Kaspi Bank плюс продуктовый mismatch (Kaspi — суперапп на 16М юзеров, Kaspy по скоупу — камерный монобанк). [Kaspi IR](https://ir.kaspi.kz/about/mobile-app).
7. **`var(--tg-viewport-height)` вместо `100vh`, `viewportStableHeight` вместо `viewportHeight`** — обязательные к закладке с самого начала веб-версии, иначе порт в TMA потребует переверстки. [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps), [adsgram.ai](https://adsgram.ai/blog/adsgram/telegram-mini-app-tma-development-mistakes-and-how-to-avoid-them).
8. **Inter + indigo/purple-градиент — двойной риск для «премиального» позиционирования**: читается и как generic AI-slop (3 независимых источника), и — при неаккуратном выборе конкретного тона — как «дешёвый стартап-вайб», которого финтех 2026 избегает. Geist/General Sans + не-indigo акцент — прямая рекомендация ресёрча. [925studios.co](https://925studios.co/blog/ai-slop-design-tells), [digidop.com](https://digidop.com/blog/2026-design-trends-for-finance-websites).
9. **Cloudflare Pages выбран отчасти по юридической причине**, не только техническим цифрам — Vercel Hobby ToS явно запрещает коммерческое использование, что стало бы блокером задним числом при росте проекта. [puter.com blog](https://developer.puter.com/blog/cloudflare-pages-alternatives).
10. **Ни один open-source репозиторий не закрывает скоуп «2 счёта + история + карты + переводы» с нужной полировкой** — вывод сделан по прямому обзору кандидатов (shadcn-fintech, react-banking-app-template и др.), не по единственному источнику: писать UI с нуля быстрее, чем адаптировать чужую архитектуру. opensource.md, раздел «Вердикт».
