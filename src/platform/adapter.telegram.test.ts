import { afterEach, describe, expect, it, vi } from 'vitest';

function available(implementation: (...args: never[]) => unknown = () => undefined) {
  return Object.assign(vi.fn(implementation), {
    isAvailable: vi.fn(() => true),
    supports: vi.fn(() => true),
  });
}

function sdkMock() {
  const removeMainClick = vi.fn();
  const removeBackClick = vi.fn();
  const isThemeParamsDark = Object.assign(vi.fn(() => true), {
    sub: vi.fn((_listener: (isDark: boolean) => void) => vi.fn()),
  });
  return {
    init: vi.fn(),
    initData: {
      restore: vi.fn(),
      user: vi.fn<
        () => { id: number; first_name: string; last_name: string } | undefined
      >(() => ({ id: 9_007_199_254_740_991, first_name: 'Ada', last_name: 'Lovelace' })),
    },
    retrieveRawInitData: vi.fn(() => 'signed-init-data'),
    themeParams: {
      isMounted: vi.fn(() => false),
      mount: available(),
      isCssVarsBound: vi.fn(() => false),
      bindCssVars: available(),
      isDark: isThemeParamsDark,
    },
    miniApp: {
      isMounted: vi.fn(() => false),
      mount: available(),
      ready: available(),
      setBgColor: available(),
      setBottomBarColor: available(),
      setHeaderColor: available(),
    },
    mainButton: {
      isMounted: vi.fn(() => false),
      mount: available(),
      onClick: available(() => removeMainClick),
      setParams: available(),
      hide: available(),
    },
    backButton: {
      isMounted: vi.fn(() => false),
      isSupported: vi.fn(() => true),
      mount: available(),
      onClick: available(() => removeBackClick),
      show: available(),
      hide: available(),
    },
    viewport: {
      isMounted: vi.fn(() => false),
      mount: available(async () => undefined),
      isCssVarsBound: vi.fn(() => false),
      bindCssVars: available(),
      expand: available(),
    },
    hapticFeedback: {
      impactOccurred: available(),
      notificationOccurred: available(),
    },
    removeMainClick,
    removeBackClick,
  };
}

async function loadAdapter() {
  const sdk = sdkMock();
  vi.doMock('@tma.js/sdk-react', () => sdk);
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  const module = await import('./adapter.telegram');
  return {
    sdk,
    createTelegramAdapter: module.createTelegramAdapter,
    initializeTelegram: module.initializeTelegram,
    isTelegramSetupComplete: module.isTelegramSetupComplete,
    normalizeDisplayName: module.normalizeDisplayName,
    normalizeTelegramId: module.normalizeTelegramId,
    parseLaunchPreferences: module.parseLaunchPreferences,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('createTelegramAdapter', () => {
  it('hides native controls restored by Telegram when no screen owns them', async () => {
    const { sdk, createTelegramAdapter, initializeTelegram } = await loadAdapter();
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);

    createTelegramAdapter();

    expect(sdk.mainButton.mount).not.toHaveBeenCalled();
    expect(sdk.backButton.mount).not.toHaveBeenCalled();
    expect(sdk.mainButton.hide).toHaveBeenCalledOnce();
    expect(sdk.backButton.hide).toHaveBeenCalledOnce();

    initializeTelegram();

    expect(sdk.mainButton.hide).toHaveBeenCalledTimes(2);
    expect(sdk.backButton.hide).toHaveBeenCalledTimes(2);
  });

  it('continues optional setup when one Telegram capability throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter } = await loadAdapter();
    sdk.themeParams.mount.mockImplementation(() => {
      throw new Error('theme unavailable');
    });

    const adapter = createTelegramAdapter();

    expect(adapter.getCurrentUser()).toEqual({
      displayName: 'Ada Lovelace',
      source: 'host',
      telegramId: '9007199254740991',
    });
    expect(sdk.miniApp.mount).toHaveBeenCalledOnce();
    expect(sdk.miniApp.ready).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.platform).toBe('telegram');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('theme mount failed'));
  });

  it('marks a light Telegram host without rebinding dark-only brand neutrals', async () => {
    const { sdk, createTelegramAdapter } = await loadAdapter();
    sdk.themeParams.isDark.mockReturnValue(false);

    createTelegramAdapter();

    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(sdk.miniApp.setHeaderColor).toHaveBeenCalledWith('#101116');
    expect(sdk.miniApp.setBgColor).toHaveBeenCalledWith('#101116');
    expect(sdk.miniApp.setBottomBarColor).toHaveBeenCalledWith('#101116');
  });

  it('keeps the theme subscription active when an initial Mini App color setter throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter } = await loadAdapter();
    sdk.miniApp.setHeaderColor.mockImplementation(() => {
      throw new Error('header bridge not ready');
    });

    createTelegramAdapter();

    expect(sdk.themeParams.isDark.sub).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(sdk.miniApp.setBgColor).toHaveBeenCalledWith('bg_color');
    expect(sdk.miniApp.setBottomBarColor).toHaveBeenCalledWith('bottom_bar_bg_color');

    const onThemeChange = sdk.themeParams.isDark.sub.mock.calls[0]?.[0];
    expect(onThemeChange).toBeTypeOf('function');
    onThemeChange?.(false);

    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(sdk.miniApp.setBgColor).toHaveBeenLastCalledWith('#101116');
    expect(sdk.miniApp.setBottomBarColor).toHaveBeenLastCalledWith('#101116');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mini app header color failed'));
  });

  it('retries core init after a transient failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter } = await loadAdapter();
    sdk.init.mockImplementationOnce(() => {
      throw new Error('bridge not ready');
    });

    createTelegramAdapter();
    expect(sdk.miniApp.ready).not.toHaveBeenCalled();

    createTelegramAdapter();
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(sdk.miniApp.ready).toHaveBeenCalledOnce();

    createTelegramAdapter();
    expect(sdk.miniApp.ready).toHaveBeenCalledOnce();
  });

  it('keeps setup incomplete until Mini App ready succeeds', async () => {
    const { sdk, createTelegramAdapter, initializeTelegram, isTelegramSetupComplete } =
      await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.mount.isAvailable.mockReturnValue(false);
    sdk.backButton.isSupported.mockReturnValue(false);
    sdk.miniApp.ready.isAvailable.mockReturnValue(false);

    createTelegramAdapter();

    expect(sdk.viewport.expand).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(false);

    sdk.miniApp.ready.isAvailable.mockReturnValue(true);
    initializeTelegram();

    expect(sdk.miniApp.ready).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(true);
  });

  it('keeps setup incomplete until viewport expand succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, initializeTelegram, isTelegramSetupComplete } =
      await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.mount.isAvailable.mockReturnValue(false);
    sdk.backButton.isSupported.mockReturnValue(false);
    sdk.viewport.expand
      .mockImplementationOnce(() => {
        throw new Error('viewport bridge not ready');
      })
      .mockImplementation(() => undefined);

    createTelegramAdapter();

    expect(sdk.miniApp.ready).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(false);

    initializeTelegram();

    expect(sdk.viewport.expand).toHaveBeenCalledTimes(2);
    expect(isTelegramSetupComplete()).toBe(true);
  });

  it('keeps setup incomplete until init data restore succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, initializeTelegram, isTelegramSetupComplete } =
      await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    sdk.initData.restore.mockImplementationOnce(() => {
      throw new Error('init data bridge not ready');
    });

    createTelegramAdapter();

    expect(isTelegramSetupComplete()).toBe(false);
    initializeTelegram();

    expect(sdk.initData.restore).toHaveBeenCalledTimes(2);
    expect(isTelegramSetupComplete()).toBe(true);
  });

  it('lazily retries InitData restore when parsed host identity trails raw launch data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter } = await loadAdapter();
    let restored = false;
    sdk.initData.restore
      .mockImplementationOnce(() => {
        throw new Error('parsed init data not ready');
      })
      .mockImplementation(() => {
        restored = true;
      });
    sdk.initData.user.mockImplementation(() =>
      restored ? { id: 42, first_name: 'Ada', last_name: 'Lovelace' } : undefined,
    );
    expect(sdk.retrieveRawInitData()).toBe('signed-init-data');

    const adapter = createTelegramAdapter();

    expect(adapter.getCurrentUser()).toEqual({
      displayName: 'Ada Lovelace',
      source: 'host',
      telegramId: '42',
    });
    expect(sdk.initData.restore).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('init data failed'));
  });

  it('uses raw init data only for server validation while parsed identity remains unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: 1,
          revisionEpoch: '0123456789abcdef0123456789abcdef',
          revision: 1,
          locale: 'en',
          primaryCurrency: 'USD',
          displayName: 'Server Verified',
          telegramId: '42',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { sdk, createTelegramAdapter } = await loadAdapter();
    sdk.initData.restore.mockImplementation(() => {
      throw new Error('parsed init data not ready');
    });
    sdk.initData.user.mockReturnValue({ id: 41, first_name: 'Stale', last_name: 'Session' });

    const adapter = createTelegramAdapter();

    expect(adapter.getCurrentUser()).toEqual({ displayName: 'Никита', source: 'demo' });
    expect(sdk.initData.user).not.toHaveBeenCalled();
    await expect(adapter.loadLaunchPreferences()).resolves.toMatchObject({
      displayName: 'Server Verified',
      telegramId: '42',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries transient desired Main and Back control failures without duplicate listeners', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, initializeTelegram, isTelegramSetupComplete } =
      await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    sdk.mainButton.setParams.mockImplementationOnce(() => {
      throw new Error('main params bridge not ready');
    });
    sdk.backButton.show.mockImplementationOnce(() => {
      throw new Error('back visibility bridge not ready');
    });
    const adapter = createTelegramAdapter();
    const onMain = vi.fn();
    const onBack = vi.fn();

    adapter.mainButton.show({ text: 'Transfer', onClick: onMain, disabled: false });
    const disarmBack = adapter.armBack(onBack);

    expect(isTelegramSetupComplete()).toBe(false);
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);

    expect(isTelegramSetupComplete()).toBe(true);
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();

    initializeTelegram();
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    disarmBack();
  });

  it('retries transient native listener registration and keeps one successful subscription', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, initializeTelegram, isTelegramSetupComplete } =
      await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    sdk.mainButton.onClick
      .mockImplementationOnce(() => {
        throw new Error('main listener bridge not ready');
      })
      .mockImplementation(() => sdk.removeMainClick);
    sdk.backButton.onClick
      .mockImplementationOnce(() => {
        throw new Error('back listener bridge not ready');
      })
      .mockImplementation(() => sdk.removeBackClick);
    const adapter = createTelegramAdapter();
    const onMain = vi.fn();
    const onBack = vi.fn();

    adapter.mainButton.show({ text: 'Transfer', onClick: onMain, disabled: false });
    const disarmBack = adapter.armBack(onBack);
    expect(isTelegramSetupComplete()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);

    expect(sdk.mainButton.onClick).toHaveBeenCalledTimes(2);
    expect(sdk.backButton.onClick).toHaveBeenCalledTimes(2);
    expect(isTelegramSetupComplete()).toBe(true);
    initializeTelegram();
    expect(sdk.mainButton.onClick).toHaveBeenCalledTimes(2);
    expect(sdk.backButton.onClick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    disarmBack();
  });

  it('retries unavailable hide and failed removal before treating controls as synchronized', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, isTelegramSetupComplete } = await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    const adapter = createTelegramAdapter();
    const onMain = vi.fn();
    const onBack = vi.fn();
    adapter.mainButton.show({ text: 'Transfer', onClick: onMain, disabled: false });
    const disarmBack = adapter.armBack(onBack);
    sdk.removeMainClick.mockImplementationOnce(() => {
      throw new Error('main unsubscribe bridge not ready');
    });
    sdk.removeBackClick.mockImplementationOnce(() => {
      throw new Error('back unsubscribe bridge not ready');
    });
    sdk.mainButton.hide.isAvailable.mockReturnValue(false);
    sdk.backButton.hide.isAvailable.mockReturnValue(false);

    adapter.mainButton.hide();
    disarmBack();

    expect(isTelegramSetupComplete()).toBe(false);
    sdk.mainButton.hide.isAvailable.mockReturnValue(true);
    sdk.backButton.hide.isAvailable.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(sdk.removeMainClick).toHaveBeenCalledTimes(2);
    expect(sdk.removeBackClick).toHaveBeenCalledTimes(2);
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries temporarily unavailable desired control capabilities', async () => {
    vi.useFakeTimers();
    const { sdk, createTelegramAdapter, isTelegramSetupComplete } = await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    const adapter = createTelegramAdapter();
    sdk.mainButton.setParams.isAvailable.mockReturnValue(false);
    sdk.mainButton.onClick.isAvailable.mockReturnValue(false);
    sdk.backButton.show.isAvailable.mockReturnValue(false);
    sdk.backButton.onClick.isAvailable.mockReturnValue(false);
    const onMain = vi.fn();
    const onBack = vi.fn();

    adapter.mainButton.show({ text: 'Transfer', onClick: onMain, disabled: false });
    const disarmBack = adapter.armBack(onBack);

    expect(adapter.mainButton.supported).toBe(false);
    expect(isTelegramSetupComplete()).toBe(false);
    expect(sdk.mainButton.setParams).not.toHaveBeenCalled();
    expect(sdk.mainButton.onClick).not.toHaveBeenCalled();
    expect(sdk.backButton.show).not.toHaveBeenCalled();
    expect(sdk.backButton.onClick).not.toHaveBeenCalled();

    sdk.mainButton.setParams.isAvailable.mockReturnValue(true);
    sdk.mainButton.onClick.isAvailable.mockReturnValue(true);
    sdk.backButton.show.isAvailable.mockReturnValue(true);
    sdk.backButton.onClick.isAvailable.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(isTelegramSetupComplete()).toBe(true);
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    disarmBack();
  });

  it('remounts late-unmounted controls before probing their mounted-only capabilities', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, isTelegramSetupComplete } = await loadAdapter();
    let mainMounted = true;
    let backMounted = true;
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockImplementation(() => mainMounted);
    sdk.backButton.isMounted.mockImplementation(() => backMounted);
    sdk.mainButton.setParams.isAvailable.mockImplementation(() => mainMounted);
    sdk.mainButton.onClick.isAvailable.mockImplementation(() => mainMounted);
    sdk.backButton.show.isAvailable.mockImplementation(() => backMounted);
    sdk.backButton.onClick.isAvailable.mockImplementation(() => backMounted);
    const adapter = createTelegramAdapter();
    mainMounted = false;
    backMounted = false;
    sdk.mainButton.mount
      .mockImplementationOnce(() => {
        throw new Error('main remount bridge not ready');
      })
      .mockImplementation(() => {
        mainMounted = true;
      });
    sdk.backButton.mount
      .mockImplementationOnce(() => {
        throw new Error('back remount bridge not ready');
      })
      .mockImplementation(() => {
        backMounted = true;
      });

    adapter.mainButton.show({ text: 'Transfer', onClick: vi.fn(), disabled: false });
    const disarmBack = adapter.armBack(vi.fn());

    expect(isTelegramSetupComplete()).toBe(false);
    expect(sdk.mainButton.setParams).not.toHaveBeenCalled();
    expect(sdk.backButton.show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(sdk.mainButton.mount).toHaveBeenCalledTimes(2);
    expect(sdk.backButton.mount).toHaveBeenCalledTimes(2);
    expect(sdk.mainButton.setParams).toHaveBeenCalledOnce();
    expect(sdk.backButton.show).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    disarmBack();
  });

  it('does not retry a desired Back control on a genuinely unsupported client', async () => {
    vi.useFakeTimers();
    const { sdk, createTelegramAdapter, isTelegramSetupComplete } = await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(false);
    const adapter = createTelegramAdapter();
    sdk.backButton.isSupported.mockReturnValue(false);

    adapter.armBack(vi.fn());

    expect(isTelegramSetupComplete()).toBe(true);
    expect(sdk.backButton.onClick).not.toHaveBeenCalled();
    expect(sdk.backButton.show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses stable native trampolines so a failed action swap never calls the stale action', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, isTelegramSetupComplete } = await loadAdapter();
    sdk.miniApp.isMounted.mockReturnValue(true);
    sdk.viewport.isMounted.mockReturnValue(true);
    sdk.mainButton.isMounted.mockReturnValue(true);
    sdk.backButton.isMounted.mockReturnValue(true);
    const adapter = createTelegramAdapter();
    const onMainA = vi.fn();
    const onMainB = vi.fn();
    const onBackA = vi.fn();
    const onBackB = vi.fn();
    adapter.mainButton.show({ text: 'A', onClick: onMainA, disabled: false });
    const disarmBackA = adapter.armBack(onBackA);
    const registeredMainClick: unknown = sdk.mainButton.onClick.mock.calls[0]?.[0];
    const registeredBackClick: unknown = sdk.backButton.onClick.mock.calls[0]?.[0];
    if (typeof registeredMainClick !== 'function' || typeof registeredBackClick !== 'function') {
      throw new Error('Native trampoline callbacks were not registered');
    }
    sdk.mainButton.setParams.mockImplementationOnce(() => {
      throw new Error('main action swap bridge not ready');
    });
    sdk.backButton.show.mockImplementationOnce(() => {
      throw new Error('back action swap bridge not ready');
    });

    adapter.mainButton.show({ text: 'B', onClick: onMainB, disabled: false });
    const disarmBackB = adapter.armBack(onBackB);
    registeredMainClick();
    registeredBackClick();

    expect(onMainA).not.toHaveBeenCalled();
    expect(onMainB).not.toHaveBeenCalled();
    expect(onBackA).not.toHaveBeenCalled();
    expect(onBackB).not.toHaveBeenCalled();
    expect(isTelegramSetupComplete()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    registeredMainClick();
    registeredBackClick();

    expect(onMainA).not.toHaveBeenCalled();
    expect(onMainB).toHaveBeenCalledOnce();
    expect(onBackA).not.toHaveBeenCalled();
    expect(onBackB).toHaveBeenCalledOnce();
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    expect(isTelegramSetupComplete()).toBe(true);
    disarmBackA();
    disarmBackB();
  });

  it('replays desired native controls after their mounts recover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sdk, createTelegramAdapter, initializeTelegram } = await loadAdapter();
    let mainMounted = false;
    let backMounted = false;
    sdk.mainButton.isMounted.mockImplementation(() => mainMounted);
    sdk.backButton.isMounted.mockImplementation(() => backMounted);
    sdk.mainButton.mount
      .mockImplementationOnce(() => {
        throw new Error('main bridge not ready');
      })
      .mockImplementationOnce(() => {
        throw new Error('main bridge still not ready');
      })
      .mockImplementation(() => {
        mainMounted = true;
      });
    sdk.backButton.mount
      .mockImplementationOnce(() => {
        throw new Error('back bridge not ready');
      })
      .mockImplementationOnce(() => {
        throw new Error('back bridge still not ready');
      })
      .mockImplementation(() => {
        backMounted = true;
      });

    const adapter = createTelegramAdapter();
    const onMain = vi.fn();
    const onBack = vi.fn();
    adapter.mainButton.show({ text: 'Перевести', onClick: onMain, disabled: false });
    const disarmBack = adapter.armBack(onBack);
    expect(sdk.mainButton.setParams).not.toHaveBeenCalled();
    expect(sdk.backButton.onClick).not.toHaveBeenCalled();

    initializeTelegram();

    expect(sdk.mainButton.setParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Перевести', isEnabled: true, isVisible: true }),
    );
    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.show).toHaveBeenCalled();
    const registeredMainClick: unknown = sdk.mainButton.onClick.mock.calls.at(-1)?.[0];
    const registeredBackClick: unknown = sdk.backButton.onClick.mock.calls.at(-1)?.[0];
    if (typeof registeredMainClick !== 'function' || typeof registeredBackClick !== 'function') {
      throw new Error('Native control callbacks were not registered');
    }
    registeredMainClick();
    registeredBackClick();
    expect(onMain).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
    disarmBack();
  });

  it('keeps one native subscription when identical actions are replayed', async () => {
    const { sdk, createTelegramAdapter, initializeTelegram } = await loadAdapter();
    const adapter = createTelegramAdapter();
    const onMain = vi.fn();
    const onBack = vi.fn();
    const mainConfig = { text: 'Transfer', onClick: onMain, disabled: false };

    adapter.mainButton.show(mainConfig);
    const disarmBack = adapter.armBack(onBack);
    initializeTelegram();
    adapter.mainButton.show(mainConfig);

    expect(sdk.mainButton.onClick).toHaveBeenCalledOnce();
    expect(sdk.backButton.onClick).toHaveBeenCalledOnce();
    adapter.mainButton.hide();
    disarmBack();
    expect(sdk.removeMainClick).toHaveBeenCalledOnce();
    expect(sdk.removeBackClick).toHaveBeenCalledOnce();

    adapter.mainButton.show(mainConfig);
    const disarmRearmedBack = adapter.armBack(onBack);
    expect(sdk.mainButton.onClick).toHaveBeenCalledTimes(2);
    expect(sdk.backButton.onClick).toHaveBeenCalledTimes(2);
    adapter.mainButton.hide();
    disarmRearmedBack();
  });

  it('bounds viewport mount so a stalled bridge can fail and retry', async () => {
    const { sdk, createTelegramAdapter } = await loadAdapter();

    createTelegramAdapter();

    expect(sdk.viewport.mount).toHaveBeenCalledWith({ timeout: 2_500 });
  });

  it('loads strictly validated preferences without exposing raw init data to callers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: 1,
          revisionEpoch: '0123456789abcdef0123456789abcdef',
          revision: 7,
          locale: 'en',
          primaryCurrency: 'GEL',
          displayName: 'Ada Lovelace',
          telegramId: '9007199254740993',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createTelegramAdapter } = await loadAdapter();
    const adapter = createTelegramAdapter();

    await expect(adapter.loadLaunchPreferences()).resolves.toEqual({
      version: 1,
      revisionEpoch: '0123456789abcdef0123456789abcdef',
      revision: 7,
      locale: 'en',
      primaryCurrency: 'GEL',
      displayName: 'Ada Lovelace',
      telegramId: '9007199254740993',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tma/bootstrap',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('marks only transient preference HTTP failures as retryable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 502 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { createTelegramAdapter } = await loadAdapter();
    const adapter = createTelegramAdapter();

    await expect(adapter.loadLaunchPreferences()).rejects.toMatchObject({ retryable: true });
    await expect(adapter.loadLaunchPreferences()).rejects.toMatchObject({ retryable: true });
    await expect(adapter.loadLaunchPreferences()).rejects.toMatchObject({ retryable: false });
  });

  it('marks a malformed successful preference response as non-retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ version: 1, revision: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { createTelegramAdapter } = await loadAdapter();
    const adapter = createTelegramAdapter();

    await expect(adapter.loadLaunchPreferences()).rejects.toMatchObject({ retryable: false });
  });

  it('normalizes safe host names and falls back for unsafe Telegram identity data', async () => {
    const { sdk, createTelegramAdapter } = await loadAdapter();
    const adapter = createTelegramAdapter();

    sdk.initData.user.mockReturnValue({
      id: 42,
      first_name: '  Jose\u0301',
      last_name: '\u00a0\u3000Lovelace  ',
    });
    expect(adapter.getCurrentUser()).toEqual({
      displayName: 'Jos\u00e9 Lovelace',
      source: 'host',
      telegramId: '42',
    });

    for (const displayName of [
      'Ada\nAdmin',
      'Ada\u202eAdmin',
      `Ada${String.fromCharCode(0xd800)}Admin`,
      'x'.repeat(49),
    ]) {
      sdk.initData.user.mockReturnValue({ id: 42, first_name: displayName, last_name: '' });
      expect(adapter.getCurrentUser()).toEqual({
        displayName: 'Никита',
        source: 'demo',
        telegramId: '42',
      });
    }
  });
});

describe('parseLaunchPreferences', () => {
  it('exposes only canonical decimal Telegram IDs', async () => {
    const { normalizeTelegramId } = await loadAdapter();

    expect(normalizeTelegramId(9_007_199_254_740_991)).toBe('9007199254740991');
    expect(normalizeTelegramId('9007199254740993')).toBe('9007199254740993');
    expect(normalizeTelegramId(9_007_199_254_740_992)).toBeUndefined();
    expect(normalizeTelegramId('042')).toBeUndefined();
    expect(normalizeTelegramId('1e9')).toBeUndefined();
    expect(normalizeTelegramId(0)).toBeUndefined();
  });

  it('normalizes NFC and Unicode separators within the 48-code-point limit', async () => {
    const { normalizeDisplayName } = await loadAdapter();

    expect(normalizeDisplayName('\u00a0  Jose\u0301\u3000Lovelace  ')).toBe('Jos\u00e9 Lovelace');
    expect(normalizeDisplayName('x'.repeat(48))).toBe('x'.repeat(48));
    expect(normalizeDisplayName('x'.repeat(49))).toBeNull();
    expect(normalizeDisplayName('😀'.repeat(48))).toBe('😀'.repeat(48));
    expect(normalizeDisplayName('😀'.repeat(49))).toBeNull();
  });

  it('rejects unsupported fields, invalid revision epochs, and unsafe server names', async () => {
    const { parseLaunchPreferences } = await loadAdapter();
    const valid = {
      version: 1,
      revisionEpoch: '0123456789abcdef0123456789abcdef',
      revision: 1,
      locale: 'ru',
      primaryCurrency: 'KZT',
      displayName: 'Никита',
      telegramId: '123456789',
    };

    expect(() => parseLaunchPreferences({ ...valid, primaryCurrency: 'BTC' })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, revisionEpoch: undefined })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, revisionEpoch: 'A'.repeat(32) })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, revisionEpoch: '0'.repeat(31) })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, revision: 1.5 })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, telegramId: '1e9' })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, displayName: 'Ada\nAdmin' })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, displayName: 'Ada\u202eAdmin' })).toThrow();
    expect(() =>
      parseLaunchPreferences({
        ...valid,
        displayName: `Ada${String.fromCharCode(0xd800)}Admin`,
      }),
    ).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, displayName: 'Jose\u0301' })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, displayName: 'Ada\u00a0Lovelace' })).toThrow();
    expect(() => parseLaunchPreferences({ ...valid, displayName: 'x'.repeat(49) })).toThrow();
    expect(parseLaunchPreferences({ ...valid, displayName: 'x'.repeat(48) }).displayName).toBe(
      'x'.repeat(48),
    );
  });
});
