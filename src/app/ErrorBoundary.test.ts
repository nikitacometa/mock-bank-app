import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const CRASH_MESSAGE = 'Что-то сломалось. Данные — демо, так что проще всего начать заново.';

function renderCrashFallback(locale: 'ru' | 'en' = 'ru'): string {
  const boundary = new ErrorBoundary({
    locale,
    onReset: vi.fn(),
    children: createElement('div', null, 'app'),
  });
  boundary.state = { failed: true };
  return renderToStaticMarkup(boundary.render());
}

describe('ErrorBoundary crash fallback', () => {
  it('announces the crash through exactly one alert', () => {
    const markup = renderCrashFallback();

    expect(markup.match(/role="alert"/g)).toHaveLength(1);
    expect(markup.match(new RegExp(CRASH_MESSAGE, 'g'))).toHaveLength(1);
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>[^<]*Что-то сломалось\.[^<]*<\/p>/);
  });

  it('autofocuses the recovery button when the fallback mounts', () => {
    const markup = renderCrashFallback();

    expect(markup).toMatch(/<button[^>]*autofocus=""[^>]*>Перезапустить демо<\/button>/);
  });

  it('renders the same accessible recovery surface in English', () => {
    const markup = renderCrashFallback('en');

    expect(markup.match(/role="alert"/g)).toHaveLength(1);
    expect(markup).toContain('Something broke.');
    expect(markup).toMatch(/<button[^>]*autofocus=""[^>]*>Restart demo<\/button>/);
    expect(markup).not.toContain(CRASH_MESSAGE);
  });
});
