# Context-packet: дизайн-практики и фронтенд-конвенции юзера

Собрано из `~/dev` (flexq-web, flexq-extension, boost/*, vibe-ssh-telegram-bot, eidolon-telegram)
и `~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/frontend-design`.
`kaspy-bank-telegram` (target repo) — пустая директория, ничего не унаследовать оттуда.

## 1. Дизайн-практики по проектам (с file:line)

### flexq-web — "Ember Neon" (маркетинг + мок-интервью, ~/dev/flexq-web)
- Design system формально задокументирован: `CLAUDE.md:277-341` ("Design system — Ember Neon").
- Токены цвета — инлайн-блок в `public/index.html` (`CLAUDE.md:283-296`): warm near-black `--bg: oklch(0.09 0.012 60)`,
  два уровня surface, `--accent`/`--neon` — амбер (`oklch(0.8 0.15 70)` / `oklch(0.87 0.21 78)`),
  `--good` зелёный для чекмарок, составные `--glow`/`--glow-sm` тени, `--ease: cubic-bezier(0.16, 1, 0.3, 1)`.
- Разные CSS-поверхности (`legal.css`, `funnel.css`, `stage.css`, инлайн homepage) имеют СВОИ scope токенов
  с одинаковыми семантическими именами, но разными значениями — `CLAUDE.md:63-69, 279`.
- Типографика (`CLAUDE.md:302-309`): body — `'Avenir Next', 'Helvetica Neue', system-ui` 400/16px/1.62;
  моно (kickers/labels) — `'SF Mono', ui-monospace` 0.85em tracking 0.04em; display (h1/h2/`.big`) —
  `'Space Grotesk'` (Google Fonts, wght 400-700). `<em>` = neon highlight, не больше одного слова на заголовок.
- Ambient layers z-order (`CLAUDE.md:311-317`): canvas-частицы (paused при `prefers-reduced-motion`) →
  два radial-gradient блоба фона → scanline-оверлей `body::after` (**"визуальный fingerprint продукта, не удалять"**,
  z-index 90) — всё, что поверх (модалки/тосты), обязано быть z-index > 90.
- **Neon discipline** (`CLAUDE.md:319-325`): glow reserved на ~3 фокальных элемента на вьюпорт максимум —
  больше схлопывается в однородную текстуру без фокуса. Glow = состояние (hover/focus/streaming), не декор;
  body text никогда не светится.
- Reveal-система на IntersectionObserver (`CLAUDE.md:359-370`): `html.js .reveal{opacity:0;translateY(26px)}`
  → `.in` добавляется при threshold 0.12, `io.unobserve()` после первого срабатывания (one-way анимация).
- Design axis (`CLAUDE.md:424-433`): **"bold landing, calm in-app"** — на лендинге интенсивность на максимум
  (glow/scale/particles), в самом продукте — сдержанно: баланс кредитов скрыт пока >1ч остатка, tier показан
  словом ("Best"/"Std") а не множителем, upgrade-prompt только когда кредиты кончились, не как постоянный элемент.
- Visual QA workflow (`CLAUDE.md:435-443`): 2-3 варианта → Playwright скриншоты на ширинах [460,700,900] →
  мобильный вьюпорт 390 с форс-reveal перед скриншотом → выбор на глаз → hardcode winner.

### flexq-extension — тот же язык, другой стек (~/dev/flexq-extension)
- `CLAUDE.md:256-257`: "UI: React 19 + Tailwind v4 (ember-neon tokens in `sidepanel/style.css`) + Motion.
  Match `flexq-web` design language (pure dark, `oklch` accent, neon glow reserved for ~3 focal elements).
  No generic-AI aesthetics." — **прямое переиспользование дизайн-системы между проектами**, а не копия кода.
- Гвард-паттерн безопасности сходно формулируется как дизайн-принцип: "Guard-before-display, always" (`CLAUDE.md:40`).

### boost-frontend — прод TMA-подобный SPA (Vue) для V-Boost (~/dev/boost/boost-frontend)
- shadcn-vue: `components.json` — style `new-york`, `baseColor: neutral`, iconLibrary `lucide`, алиасы
  `@/components`, `@/lib/utils`, `@/components/Ui`.
- Tailwind 4 (`@tailwindcss/vite`) + `tw-animate-css`, кастомный `@theme{--breakpoint-xs:390px}` — узкий брейкпоинт
  под мобильный/мини-апп формат (`src/styles/style.css:1-8`).
- Классическая shadcn `@theme inline` схема с `--radius-sm/md/lg/xl` и полным набором `--color-*` алиасов на
  CSS-переменные (`style.css:10-51`), light `:root` + `.dark` оверрайды через `oklch()`.
- Брендовый цвет прокинут через переменную: `--primary: var(--color-brand-red)` (`style.css:66`), сам бренд-цвет
  живёт в отдельном legacy-файле `src/assets/styles/variables.css` (`--color-brand-red: #ff4744`,
  `--color-brand-cyan: #02cdd0`) — двухслойная система токенов (semantic → brand primitives).
- `variables.css:1-60` — большой плоский набор legacy CSS-переменных (`--color-white-*`, `--color-text-*`,
  `--color-border-*`, `--color-success/warn/error`) поверх которых стоит shadcn-слой — миграция в процессе,
  не чистый token-single-source.
- Стек фичей: `@vueuse/core`, `pinia`, `@tanstack/vue-query`, `vee-validate`, embla-carousel, vaul-vue (drawer),
  cropperjs — типичный набор для мобильного TMA/SPA на Vue.
- Никакого прямого использования `telegram-web-app.js`/`@twa-dev` SDK в коде не найдено (grep по `src` пуст) —
  V-Boost фронт работает как обычный веб (app.v-boost.top), Telegram — отдельный ops-бот, не хостит SPA внутри TWA.

### boost-pulse — есть `DESIGN_BACKLOG.md` (не прочитан целиком, дизайн-долг отслеживается отдельным файлом
  в корне репо — паттерн: держать backlog дизайн-issues рядом с кодом, не только в тасктрекере).

### `~/.claude/plugins/.../skills/frontend-design/SKILL.md` — общий гайд по дизайну интерфейсов
Ключевые принципы (кратко, это generic skill, не проектный):
- Не templated-дефолт: явно называть 3 AI-дефолтных лука, которых избегать — (1) кремовый фон + serif +
  terracotta, (2) near-black + один яркий acid-green/vermilion акцент, (3) broadsheet/hairline-rules без radius.
- Процесс: brainstorm (компактная token-система: цвет 4-6 hex, тип 2+ роли, layout-концепт ASCII-wireframe,
  "signature"-элемент) → сверка плана на "не generic ли это" → билд → скриншот-самокритика → срезать один
  лишний элемент (принцип Chanel).
- Motion — только там, где служит содержанию; избыток анимации читается как "AI-generated".
- Copy как дизайн-материал: active voice, называть по тому, что контролирует пользователь (не по имени
  системы), кнопка/тост/лейбл держат одну и ту же лексику через весь флоу.
- Quality floor: адаптив до мобильного, видимый keyboard focus, `prefers-reduced-motion` соблюдается.

## 2. Переиспользуемые токены/паттерны (кросс-проектные)

- **"Ember Neon"** — фактически именованная дизайн-система юзера для тёмных продуктовых интерфейсов,
  переиспользуемая между flexq-web (лендинг) и flexq-extension (расширение): warm near-black `oklch` фон,
  amber/neon акцент, scanline/glow как fingerprint, glow reserved на ~3 фокальных элемента, `cubic-bezier(0.16,1,0.3,1)` ease.
- **Двухслойные токены**: semantic CSS vars (`--background`, `--primary`, `--muted`) поверх brand primitives
  (`--color-brand-red`, `--color-brand-cyan`) — паттерн в boost-frontend, типичен для shadcn-based проектов.
- **oklch() как цветовое пространство по умолчанию** и в flexq-web, и в boost-frontend (не hex/hsl).
- **shadcn/ui-style компонентная система** (`components.json`, `new-york` style, `lucide` иконки) — стандарт
  для Vue/React проектов юзера с Tailwind.
- **z-index-дисциплина**: явно документировать "порог", выше которого обязаны быть все оверлеи/модалки
  (flexq-web: scanline на z-index 90).
- **"Bold landing, calm in-app"** — общий принцип: разная интенсивность дизайна для маркетинговой поверхности
  vs. продуктового интерфейса того же продукта.
- **Visual QA через Playwright**: скриншоты на нескольких ширинах + мобильный вьюпорт 390, форс анимаций
  перед снимком — повторяющаяся практика (flexq-web `CLAUDE.md`, упомянуто и в CLAUDE.md глобальном как
  "кодек/скриншот" грабля).

## 3. Реальные фронтенд-стеки юзера (по проектам)

| Проект | Фреймворк | Сборка | Стейт | CSS | Деплой |
|---|---|---|---|---|---|
| flexq-web | ванильный HTML/inline JS (без SPA-фреймворка) | Cloudflare `wrangler` (Workers) | — | инлайн `<style>` per-surface + отдельные `.css` (legal/funnel/stage) | `wrangler deploy`, Cloudflare Workers |
| flexq-extension | React 19 | WXT (`wxt build`/`wxt zip`), Chrome MV3 | React state / chrome.storage | Tailwind v4 (`@tailwindcss/vite`) + Motion | Chrome Web Store (zip) |
| boost-frontend | Vue 3 + Vite + TS | Vite, `vue-tsc` | Pinia + `@tanstack/vue-query` | Tailwind v4 + shadcn-vue (`reka-ui`) | k8s (`.github/workflows/k8s-buld-deploy.yml`), tag-driven prod, branch-driven dev/stage |
| boost-telegram-bot | grammy (Node/TS бот, не фронт) | `tsc` | better-sqlite3 | — | Docker Compose на VPS (Hostinger) |
| boost-miniapp-bot | grammy (entry-point бот для мини-аппа) | `tsc`, `tsx` | — | — | (см. `kuber/` в репо — k8s) |
| vibe-ssh-telegram-bot | grammy (Node/TS бот) | `tsc`, `tsx` | — | — | Docker (`docker compose up --build`), non-root user в образе |
| eidolon-telegram | Python 3.12 + Telethon (userbot) | uv | SQLite + aiosqlite, ChromaDB | — | launchd (macOS) / systemd (Linux) daemon |
| guru-fun-frontend | Next.js + TS | pnpm | — | — (Storybook подключен) | Docker (`Dockerfile`, `docker-compose.yaml`) |

Вывод по стеку telegram-ботов юзера: устойчивый паттерн — **grammy + TypeScript + tsx(dev)/tsc(build) + zod**,
частые доп. зависимости `pino`(логи)+`pino-pretty`, `@grammyjs/auto-retry`, иногда `@grammyjs/conversations`,
`better-sqlite3` для локального стейта. Личные боты деплоятся через Docker на VPS, рабочие (boost) — через k8s.
Ни в одном найденном боте не обнаружено прямого использования Telegram Mini App SDK
(`@twa-dev/sdk`/`telegram-web-app.js`) — boost-frontend (единственный кандидат на "мини-апп UI") работает как
обычный веб-домен `app.v-boost.top`, не встроен как TWA внутри бота в этом дереве.

## 4. Грабли из CLAUDE.md/CHANGELOG про фронт/деплой/TMA

- **flexq-web** (`CLAUDE.md`):
  - `replace_all` с whitespace-padded строками ест пробелы и молча ломает CSS (пример: ` 5.5s ` → `7svar(--ease)`).
  - `<img>` c `width`/`height` (CLS fix) требует `height:auto` в любом CSS-правиле, задающем `width` — иначе
    intrinsic height растягивает картинку (регрессия на coach LP, hotfix `6a70434`).
  - Fixed/sticky оверлеи (баннер согласия) закрывали интерактивный контент на телефонах 3 дня — HTTP smoke
    зелёный, но клики по футеру не работали; нужен hit-test на полном скролле мобильного вьюпорта отдельным
    скриптом (`scripts/click-audit.py`), обычный smoke этот класс багов не ловит.
  - Новый query-параметр/редирект/ссылка — непротестированный URL, пока тест явно не бьёт по нему: платформенный
    пикер отдавал desktop DMG на телефоны 6 дней живого рекламного трафика, потому что мобильный тест бил
    по `/download/`, а трафик уже шёл на `/download/?platform=mac`; вдобавок сьют уже был красным от 4 других
    падений, и новая регрессия была невидима на этом фоне.
  - Каждый живой custom domain обязан быть в `wrangler.jsonc routes[]` до деплоя — неполный список
    отсоединяет пропущенные домены (инцидент flexq.app 530).
  - `api.flexq.app` обязан оставаться DNS-only (grey) в Cloudflare — проксирование ломает Stripe webhook
    подписи и SSE.
  - Скриншот-верификация анимированного текста: снятый в момент анимации кадр может выглядеть "сломанным",
    хотя анимация здоровая — нужно либо дождаться конца анимации, либо форсировать финальное состояние.
- **flexq-extension** (`CLAUDE.md`): "Guard-before-display, always" — сырой токен модели никогда не уходит
  в панель напрямую; апдейт guard-логики при смене хоста делать явным расширением, не молчаливым.
- **boost** (`CLAUDE.md`): канонический инцидент — `referral_code` пишется в `SignUp.vue`/`SignIn.vue`, но
  читается в другом месте иначе (типичный класс бага "форма → тело запроса → провод", см. паттерны выше).

## Источники (пути, дата чтения — 2026-09-01, ветки не проверялись отдельно, читал HEAD рабочих копий)

- `~/dev/flexq-web/CLAUDE.md`
- `~/dev/flexq-extension/CLAUDE.md`, `~/dev/flexq-extension/package.json`
- `~/dev/boost/boost-frontend/{package.json,components.json,src/styles/style.css,src/assets/styles/variables.css}`
- `~/dev/boost/CLAUDE.md`
- `~/dev/boost/boost-telegram-bot/package.json`
- `~/dev/boost/boost-miniapp-bot/package.json`
- `~/dev/vibe-ssh-telegram-bot/{package.json,README.md}`
- `~/dev/eidolon-telegram/CLAUDE.md`
- `~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/frontend-design/SKILL.md`
- `~/dev/kaspy-bank-telegram` — пустая директория (новый проект, ничего унаследовать)
