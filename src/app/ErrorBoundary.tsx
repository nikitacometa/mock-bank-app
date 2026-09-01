import { Component, type ReactNode } from 'react';

interface Props {
  onReset(): void;
  children: ReactNode;
}

/**
 * The worst possible failure for this product is a white screen during a live
 * demo (docs/spec.md §5.5) — any render crash lands here instead.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[cometa] render crash', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="flex flex-col items-center justify-center gap-6 px-8 text-center"
        style={{ minHeight: 'var(--app-height)' }}
      >
        <div className="kicker">Cometa</div>
        <p className="max-w-64 text-ink-2">
          Что-то сломалось. Данные — демо, так что проще всего начать заново.
        </p>
        <button
          className="rounded-btn bg-ivory px-6 py-3 font-medium text-bg active:bg-ivory-press"
          onClick={() => {
            this.props.onReset();
            this.setState({ failed: false });
          }}
        >
          Перезапустить демо
        </button>
      </div>
    );
  }
}
