# Showcase sources

Two compositions captured on 2026-09-06 UTC: application 1600 × 1240, Telegram 1600 × 1040.

## Application

`app-showcase.png` combines real 390 × 844 Chrome screenshots of the English application:
`home.png`, `transfer.png` and `history.png`. The isolated capture profile retains the four-account,
437-transaction KZT baseline. The FX screen is an unsubmitted quote; the history screen searches
subscriptions. No balances, merchants or interface text were painted over.

`app.html` is the composition source. It uses the bundled Geist font and the background below.

## Telegram

`telegram-showcase.png` combines three actual 390 × 650 Telegram Web screenshots from the live bot
on release `20260906T181102Z`. The owner-authorized John Cometa profile used a separate logged-in
Chrome instance. Only the Cometa chat is visible; no other chats, login state, raw identifiers,
credentials or launch payloads are included. UI text, balances and controls are unaltered.

- `telegram-dashboard-real.png`: dashboard and the expense account picker.
- `telegram-recurring-real.png`: monthly Spotify entry, paused after a successful two-entry backfill
  from 2026-07-16; KZT 3,210 per month. Existing history remains intact.
- `telegram-accounts-real.png`: account list and current-account controls after testing add,
  adjustment, closure and restoration. The extra THB QA account is closed at zero.

These are separate moments in the same real chat, not a continuous transcript or native Android/iOS
acceptance. The three panels remain in one row. `telegram.html` adds only the editorial frame,
captions and decorative background. The older `telegram-preview.json` is retained as historical
engine-preview evidence and is no longer used by the public composition.

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
1600 × 1240 (application) or 1600 × 1040 (Telegram) viewport. Wait for `document.fonts.ready`; the Telegram page also sets
`document.documentElement.dataset.ready` to `true` after rendering. Capture with `scale: 'css'`.
Inspect the result for clipping and verify that every panel remains readable at README width.
