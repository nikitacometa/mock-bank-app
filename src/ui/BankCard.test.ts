// @vitest-environment happy-dom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildSeed } from '@/domain/seed';
import type { CardDesign } from '@/domain/types';
import { BankCard } from './BankCard';

interface ParsedColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

function linearToSrgb(channel: number): number {
  const bounded = Math.max(0, Math.min(1, channel));
  return bounded <= 0.0031308
    ? 12.92 * bounded
    : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function parseOklch(value: string): ParsedColor {
  const match = /oklch\(([^)]+)\)/.exec(value);
  if (!match) throw new Error(`Missing oklch color in: ${value}`);
  const tokens = match[1].replace('/', ' ').trim().split(/\s+/);
  const [lightnessToken, chromaToken, hueToken, alphaToken] = tokens;
  if (!lightnessToken || !chromaToken || !hueToken) {
    throw new Error(`Invalid oklch color: ${value}`);
  }

  const lightness = Number(lightnessToken);
  const chroma = Number(chromaToken);
  const hueRadians = Number(hueToken) * Math.PI / 180;
  const labA = chroma * Math.cos(hueRadians);
  const labB = chroma * Math.sin(hueRadians);
  const lRoot = lightness + 0.3963377774 * labA + 0.2158037573 * labB;
  const mRoot = lightness - 0.1055613458 * labA - 0.0638541728 * labB;
  const sRoot = lightness - 0.0894841775 * labA - 1.291485548 * labB;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const alpha = alphaToken === undefined
    ? 1
    : Number.parseFloat(alphaToken) / (alphaToken.endsWith('%') ? 100 : 1);

  return {
    red: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    green: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    blue: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  };
}

function relativeLuminance(color: ParsedColor): number {
  return (
    0.2126 * srgbToLinear(color.red) +
    0.7152 * srgbToLinear(color.green) +
    0.0722 * srgbToLinear(color.blue)
  );
}

function composite(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  return {
    red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
    green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
    blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    alpha: 1,
  };
}

function contrastRatio(foreground: ParsedColor, background: ParsedColor): number {
  const foregroundLuminance = relativeLuminance(composite(foreground, background));
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('BankCard face contrast', () => {
  it.each<CardDesign>(['midnight', 'ivory', 'mint'])(
    'keeps %s holder and expiry small text at WCAG AA contrast',
    (design) => {
      const card = buildSeed('2026-09-02T00:00:00.000Z').cards.find(
        (candidate) => candidate.design === design,
      );
      if (!card) throw new Error(`Missing ${design} card fixture`);
      const markup = renderToStaticMarkup(createElement(BankCard, { card }));
      const backgroundStyle = /background:([^;"]+)/.exec(markup)?.[1];
      if (!backgroundStyle) throw new Error(`Missing ${design} card background`);
      const gradientColors = [...backgroundStyle.matchAll(/oklch\([^)]+\)/g)];
      const terminalColor = gradientColors.at(-1)?.[0];
      if (!terminalColor) throw new Error(`Missing ${design} terminal gradient color`);
      const background = parseOklch(terminalColor);
      const dimTextColors = [...markup.matchAll(/color:(oklch\([^)]*\/[^)]*\))/g)]
        .map((match) => match[1]);

      expect(dimTextColors).toHaveLength(2);
      for (const color of dimTextColors) {
        expect(contrastRatio(parseOklch(color), background)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
