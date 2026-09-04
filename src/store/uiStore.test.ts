import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKING_ID } from '@/domain/seed';
import { useUiStore } from './uiStore';

beforeEach(() => {
  useUiStore.setState({
    locale: 'ru',
    screen: 'home',
    sheet: null,
    activeAccountId: CHECKING_ID,
    toast: null,
    toastQueue: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@/platform/environment');
  vi.resetModules();
});

describe('useUiStore locale', () => {
  it('persists an English switch, updates document language, and survives UI reset', () => {
    const setItem = vi.fn();
    const setAttribute = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal('document', {
      documentElement: { lang: 'ru' },
      querySelector: vi.fn(() => ({ setAttribute })),
    });

    const saved = useUiStore.getState().setLocale('en');
    useUiStore.getState().resetUi();

    expect(saved).toBe(true);
    expect(useUiStore.getState().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(setAttribute).toHaveBeenCalledWith(
      'content',
      'Cometa is an interactive mobile banking demo. All accounts, cards, and transactions are fictional.',
    );
    expect(setItem).toHaveBeenCalledWith('cometa.bank.locale', 'en');
  });

  it('reports a storage failure while keeping the in-memory language usable', () => {
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    });
    vi.stubGlobal('document', {
      documentElement: { lang: 'ru' },
      querySelector: vi.fn(() => null),
    });

    const saved = useUiStore.getState().setLocale('en');

    expect(saved).toBe(false);
    expect(useUiStore.getState().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps keyed notices and their FIFO order when the document language changes', () => {
    vi.stubGlobal('localStorage', { setItem: vi.fn() });
    vi.stubGlobal('document', {
      documentElement: { lang: 'ru' },
      querySelector: vi.fn(() => null),
    });
    useUiStore.setState({
      toast: { id: 91, key: 'settings.reset.failed' },
      toastQueue: [{ id: 92, key: 'app.ratesUnavailable' }],
    });

    useUiStore.getState().setLocale('en');

    expect(useUiStore.getState()).toMatchObject({
      locale: 'en',
      toast: { id: 91, key: 'settings.reset.failed' },
      toastQueue: [{ id: 92, key: 'app.ratesUnavailable' }],
    });
  });

  it('preserves every pending notice when another tab changes the locale', async () => {
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'ru'),
      setItem: vi.fn(),
    });
    vi.stubGlobal('document', {
      documentElement: { lang: 'ru' },
      querySelector: vi.fn(() => null),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') storageListener = listener;
      }),
      removeEventListener: vi.fn(),
    });
    vi.resetModules();
    const { useUiStore: isolatedStore } = await import('./uiStore');
    isolatedStore.getState().showToast('accountDetails.copyFailed');
    isolatedStore.getState().showToast('settings.reset.failed');

    storageListener?.({ key: 'cometa.bank.locale', newValue: 'en' } as StorageEvent);

    expect(isolatedStore.getState()).toMatchObject({
      locale: 'en',
      toast: { key: 'accountDetails.copyFailed' },
      toastQueue: [{ key: 'settings.reset.failed' }],
    });
  });

  it('adopts locale changes only from the active verified Telegram namespace', async () => {
    const storage = new Map<string, string>([
      ['cometa.bank.tma.user.41.locale', 'ru'],
      ['cometa.bank.tma.user.42.locale', 'en'],
    ]);
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    });
    vi.stubGlobal('document', {
      documentElement: { lang: 'ru' },
      querySelector: vi.fn(() => null),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') storageListener = listener;
      }),
      removeEventListener: vi.fn(),
    });
    // The module-scope store above is web-scoped; reload the graph so this
    // isolated store observes the Telegram environment mock.
    vi.resetModules();
    vi.doMock('@/platform/environment', () => ({ isTelegramMiniApp: () => true }));
    const { useUiStore: telegramUiStore } = await import('./uiStore');
    const persistence = await import('./persistence');
    persistence.activateTelegramPersistence('41');
    telegramUiStore.getState().reloadLocalePreference();

    storageListener?.({
      key: 'cometa.bank.tma.user.42.locale',
      newValue: 'en',
    } as StorageEvent);
    expect(telegramUiStore.getState().locale).toBe('ru');

    storageListener?.({
      key: 'cometa.bank.tma.user.41.locale',
      newValue: 'en',
    } as StorageEvent);
    expect(telegramUiStore.getState().locale).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('useUiStore navigation', () => {
  it('opens the global transfer on Home before the balance can change', () => {
    useUiStore.setState({ screen: 'history', sheet: null });

    useUiStore.getState().openGlobalTransfer();

    expect(useUiStore.getState()).toMatchObject({
      screen: 'home',
      sheet: { kind: 'transferContact' },
    });
  });
});

describe('useUiStore toast queue', () => {
  it('shows queued notices in order without overwriting the current one', () => {
    const { showToast, clearToast } = useUiStore.getState();

    showToast('settings.reset.done');
    showToast('app.ratesUnavailable');

    expect(useUiStore.getState().toast?.key).toBe('settings.reset.done');
    clearToast();
    expect(useUiStore.getState().toast?.key).toBe('app.ratesUnavailable');
    clearToast();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it('gives identical consecutive notices distinct lifecycles', () => {
    const { showToast, clearToast } = useUiStore.getState();

    showToast('settings.reset.failed');
    const firstId = useUiStore.getState().toast?.id;
    showToast('settings.reset.failed');
    clearToast();

    expect(useUiStore.getState().toast?.key).toBe('settings.reset.failed');
    expect(useUiStore.getState().toast?.id).not.toBe(firstId);
  });
});

describe('useUiStore recovery', () => {
  it('resets navigation, selection, and notices before the error boundary remounts', () => {
    useUiStore.setState({
      screen: 'cards',
      sheet: { kind: 'cardDetail', cardId: 'missing-card' },
      activeAccountId: 'missing-account',
      toast: { id: 91, key: 'settings.reset.failed' },
      toastQueue: [{ id: 92, key: 'app.ratesUnavailable' }],
    });

    useUiStore.getState().resetUi();

    expect(useUiStore.getState()).toMatchObject({
      screen: 'home',
      sheet: null,
      activeAccountId: CHECKING_ID,
      toast: null,
      toastQueue: [],
    });
  });
});
