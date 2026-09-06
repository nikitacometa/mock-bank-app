# Showcase sources

Two 1600 × 1240 compositions, captured on 2026-09-06.

## Application

`app-showcase.png` combines real 390 × 844 Chrome screenshots of the English application:
`home.png`, `transfer.png` and `history.png`. The isolated capture profile retains the four-account,
437-transaction KZT baseline. The FX screen is an unsubmitted quote; the history screen searches
subscriptions. No balances, merchants or interface text were painted over.

`app.html` is the composition source. It uses the bundled Geist font and the background below.

## Telegram

`telegram-showcase.png` is a clearly labeled, sanitized product preview, not a Telegram screenshot.
`telegram-preview.json` contains exact responses and keyboard labels captured from the production
OnboardingEngine and BankFlowEngine using the real domain, BankAuthorityService and isolated SQLite.
The identity is fictional. No Telegram API requests or production writes were made for this preview.

The monthly Spotify example starts on 2026-07-16. With a fixed 2026-09-06 UTC clock, the engine
previews two historical entries of KZT 3,210. Only buttons returned by the engine are displayed.
The three panels deliberately omit intermediate wizard steps; they are a feature overview, not a
continuous chat transcript. `telegram.html` renders their layout.

Do not treat these previews as real-profile or Android/iOS acceptance evidence. Replace them with
three sanitized real-client captures once the corresponding live journeys pass, retaining the
one-row composition and recording their provenance here.

## Generated background

`backdrop.png` was generated with the built-in OpenAI image-generation tool. Only this decorative
background is AI-generated; application UI screenshots and bot messages are not invented.

Prompt direction: a quiet editorial matte-charcoal background, a physical warm-ivory brushed-metal
comet ribbon limited to the lower edge and right side, restrained sage reflection, ample clean
negative space. No text, UI, phones, logos, neon, stars or glass. The tool did not expose a specific
model identifier, so no GPT Image or Nano Banana version is claimed.

## Render

Serve the repository root with a local static server. Open
`/docs/assets/showcase/app.html` or `/docs/assets/showcase/telegram.html` in Playwright at a
1600 × 1240 viewport. Wait for `document.fonts.ready`; the Telegram page also sets
`document.documentElement.dataset.ready` to `true` after rendering. Capture with `scale: 'css'`.
Inspect the result for clipping and verify that every panel remains readable at README width.
