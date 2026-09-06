import {
  backButton,
  hapticFeedback,
  init,
  initData,
  mainButton,
  miniApp,
  retrieveRawInitData,
  themeParams,
  viewport,
} from '@tma.js/sdk-react';
import type { PlatformAdapter, PlatformUser } from './types';
import { copyTextToClipboard } from './clipboard';
import { isClientMutationId } from './clientMutationId';
import {
  assertServerRevisionDigest,
  normalizeDisplayName,
  parseBankCommandResponse,
  parseBankImportResponse,
  parseBankRatesRefreshResponse,
  parseLaunchState,
  parseTelegramApiError,
  TelegramApiRequestError,
  TelegramApiResponseError,
} from './bankApi';

export { normalizeDisplayName, parseLaunchPreferences } from './bankApi';

let initialized = false;
let initDataRestored = false;
let readySent = false;
let viewportExpanded = false;
let removeMainButtonClick: VoidFunction | null = null;
let removeBackButtonClick: VoidFunction | null = null;
let activeMainButtonAction: VoidFunction | null = null;
let activeBackAction: VoidFunction | null = null;
let removeThemeSchemeChange: VoidFunction | null = null;
let viewportMounting: Promise<void> | null = null;
let mainButtonSynced = false;
let backButtonSynced = false;
let nativeControlsRetryIndex = 0;
let nativeControlsRetryId: ReturnType<typeof globalThis.setTimeout> | undefined;
let desiredMainButton: Parameters<PlatformAdapter['mainButton']['show']>[0] | null = null;
let desiredBackAction: VoidFunction | null = null;
const BRAND_DARK_CHROME = '#101116' as const;
const VIEWPORT_MOUNT_TIMEOUT_MS = 2_500;
const NATIVE_CONTROLS_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;
const forwardMainButtonClick = () => activeMainButtonAction?.();
const forwardBackButtonClick = () => activeBackAction?.();

export function normalizeTelegramId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}


function clearMainButtonBinding(): boolean {
  const removeClick = removeMainButtonClick;
  if (removeClick === null) return true;
  if (!safeSdk('main button listener removal', removeClick)) return false;
  removeMainButtonClick = null;
  return true;
}

function clearBackButtonBinding(): boolean {
  const removeClick = removeBackButtonClick;
  if (removeClick === null) return true;
  if (!safeSdk('back button listener removal', removeClick)) return false;
  removeBackButtonClick = null;
  return true;
}

function safeSdk(label: string, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown SDK error';
    console.warn(`[telegram] ${label} failed: ${message}`);
    return false;
  }
}

function restoreInitData(): boolean {
  if (initDataRestored) return true;
  initDataRestored = safeSdk('init data', initData.restore);
  return initDataRestored;
}

function readTelegramUser(): ReturnType<typeof initData.user> | undefined {
  if (!restoreInitData()) return undefined;

  let user: ReturnType<typeof initData.user> | undefined;
  const readSucceeded = safeSdk('read init data user', () => {
    user = initData.user();
  });
  if (readSucceeded && user !== undefined) return user;

  // SDK 3.3 can expose raw launch data before its parsed InitData signal has
  // recovered. Treat an empty/throwing user signal as a transient restore,
  // then retry lazily on this read and on every later bootstrap attempt.
  initDataRestored = false;
  if (!restoreInitData()) return undefined;
  safeSdk('read restored init data user', () => {
    user = initData.user();
  });
  if (user === undefined) initDataRestored = false;
  return user;
}

function getCurrentTelegramUser(): PlatformUser {
  const user = readTelegramUser();
  const displayName = normalizeDisplayName(
    [user?.first_name, user?.last_name].filter(Boolean).join(' '),
  );
  const telegramId = normalizeTelegramId(user?.id);
  return displayName
    ? { displayName, source: 'host', ...(telegramId === undefined ? {} : { telegramId }) }
    : {
        displayName: 'Никита',
        source: 'demo',
        ...(telegramId === undefined ? {} : { telegramId }),
      };
}

function sdkAvailable(label: string, check: () => boolean): boolean {
  let available = false;
  safeSdk(label, () => {
    available = check();
  });
  return available;
}

function setTelegramColorScheme(isDark: boolean): void {
  document.documentElement.dataset.colorScheme = isDark ? 'dark' : 'light';
}

function syncMiniAppChrome(isDark: boolean): void {
  safeSdk('mini app header color', () => {
    if (miniApp.setHeaderColor.isAvailable()) {
      if (isDark || !miniApp.setHeaderColor.supports('rgb')) {
        miniApp.setHeaderColor('bg_color');
      } else {
        miniApp.setHeaderColor(BRAND_DARK_CHROME);
      }
    }
  });
  safeSdk('mini app background color', () => {
    if (miniApp.setBgColor.isAvailable()) {
      miniApp.setBgColor(isDark ? 'bg_color' : BRAND_DARK_CHROME);
    }
  });
  safeSdk('mini app bottom bar color', () => {
    if (miniApp.setBottomBarColor.isAvailable()) {
      miniApp.setBottomBarColor(isDark ? 'bottom_bar_bg_color' : BRAND_DARK_CHROME);
    }
  });
}

function syncDesiredMainButton(): boolean {
  const config = desiredMainButton;
  if (config === null) {
    activeMainButtonAction = null;
    if (!sdkAvailable('main button mount support', mainButton.mount.isAvailable)) {
      return clearMainButtonBinding();
    }
    let mounted = false;
    const mountStateKnown = safeSdk('main button mounted state', () => {
      mounted = mainButton.isMounted();
    });
    const bindingSynced = clearMainButtonBinding();
    if (!mountStateKnown) return false;
    if (!mounted) return bindingSynced;
    const hideAvailable = sdkAvailable('main button hide availability', mainButton.hide.isAvailable);
    const visibilitySynced =
      hideAvailable && safeSdk('main button restored state hide', mainButton.hide);
    return bindingSynced && visibilitySynced;
  }
  const mountAvailable = sdkAvailable(
    'main button mount availability',
    mainButton.mount.isAvailable,
  );
  if (!mountAvailable) return false;
  const mounted = safeSdk('main button mount', () => {
    if (!mainButton.isMounted()) mainButton.mount();
  });
  if (!mounted) return false;
  const paramsAvailable = sdkAvailable(
    'main button params availability',
    mainButton.setParams.isAvailable,
  );
  const listenerAvailable =
    removeMainButtonClick !== null ||
    sdkAvailable('main button listener availability', mainButton.onClick.isAvailable);
  if (!paramsAvailable || !listenerAvailable) return false;
  if (
    removeMainButtonClick === null &&
    !safeSdk('main button listener', () => {
      removeMainButtonClick = mainButton.onClick(forwardMainButtonClick);
    })
  ) {
    return false;
  }
  const paramsSynced = safeSdk('main button sync', () => {
    mainButton.setParams({
      text: config.text,
      isEnabled: !config.disabled,
      isVisible: true,
      hasShineEffect: false,
    });
  });
  if (!paramsSynced) return false;
  activeMainButtonAction = config.onClick;
  return true;
}

function syncDesiredBackButton(): boolean {
  const onBack = desiredBackAction;
  if (onBack === null) {
    activeBackAction = null;
    let supported = false;
    if (!safeSdk('back button support state', () => (supported = backButton.isSupported()))) {
      return false;
    }
    const bindingSynced = clearBackButtonBinding();
    if (!supported) return bindingSynced;
    let mounted = false;
    if (!safeSdk('back button mounted state', () => (mounted = backButton.isMounted()))) {
      return false;
    }
    if (!mounted) return bindingSynced;
    const hideAvailable = sdkAvailable('back button hide availability', backButton.hide.isAvailable);
    const visibilitySynced = hideAvailable && safeSdk('back button restored state hide', backButton.hide);
    return bindingSynced && visibilitySynced;
  }
  let supported = false;
  if (!safeSdk('back button support state', () => (supported = backButton.isSupported()))) {
    return false;
  }
  if (!supported) {
    activeBackAction = null;
    return clearBackButtonBinding();
  }
  const mountAvailable = sdkAvailable(
    'back button mount availability',
    backButton.mount.isAvailable,
  );
  if (!mountAvailable) return false;
  const mounted = safeSdk('back button mount', () => {
    if (!backButton.isMounted()) backButton.mount();
  });
  if (!mounted) return false;
  const showAvailable = sdkAvailable('back button show availability', backButton.show.isAvailable);
  const listenerAvailable =
    removeBackButtonClick !== null ||
    sdkAvailable('back button listener availability', backButton.onClick.isAvailable);
  if (!showAvailable || !listenerAvailable) return false;
  if (
    removeBackButtonClick === null &&
    !safeSdk('back button listener', () => {
      removeBackButtonClick = backButton.onClick(forwardBackButtonClick);
    })
  ) {
    return false;
  }
  if (!safeSdk('back button sync', backButton.show)) return false;
  activeBackAction = onBack;
  return true;
}

function reconcileNativeControlsRetry(): void {
  if (mainButtonSynced && backButtonSynced) {
    if (nativeControlsRetryId !== undefined) {
      globalThis.clearTimeout(nativeControlsRetryId);
      nativeControlsRetryId = undefined;
    }
    nativeControlsRetryIndex = 0;
    return;
  }
  if (
    nativeControlsRetryId !== undefined ||
    nativeControlsRetryIndex >= NATIVE_CONTROLS_RETRY_DELAYS_MS.length
  ) {
    return;
  }
  const delayMs = NATIVE_CONTROLS_RETRY_DELAYS_MS[nativeControlsRetryIndex++];
  nativeControlsRetryId = globalThis.setTimeout(() => {
    nativeControlsRetryId = undefined;
    mainButtonSynced = syncDesiredMainButton();
    backButtonSynced = syncDesiredBackButton();
    reconcileNativeControlsRetry();
  }, delayMs);
}

function restartNativeControlsRetry(): void {
  if (nativeControlsRetryId !== undefined) {
    globalThis.clearTimeout(nativeControlsRetryId);
    nativeControlsRetryId = undefined;
  }
  nativeControlsRetryIndex = 0;
}

function syncNativeControls(): void {
  mainButtonSynced = syncDesiredMainButton();
  backButtonSynced = syncDesiredBackButton();
  reconcileNativeControlsRetry();
}

function syncMainButtonAfterIntent(): void {
  restartNativeControlsRetry();
  mainButtonSynced = syncDesiredMainButton();
  reconcileNativeControlsRetry();
}

function syncBackButtonAfterIntent(): void {
  restartNativeControlsRetry();
  backButtonSynced = syncDesiredBackButton();
  reconcileNativeControlsRetry();
}

export function initializeTelegram(): void {
  document.documentElement.dataset.platform = 'telegram';

  if (!initialized) {
    if (!safeSdk('init', init)) return;
    initialized = true;
  }

  // Every optional capability gets its own guard. A broken theme or button API
  // must not prevent Telegram from receiving ready() or the other controls.
  restoreInitData();
  safeSdk('theme mount', () => {
    if (!themeParams.isMounted() && themeParams.mount.isAvailable()) themeParams.mount();
  });
  safeSdk('theme CSS variables', () => {
    if (!themeParams.isCssVarsBound() && themeParams.bindCssVars.isAvailable()) {
      themeParams.bindCssVars();
    }
  });
  safeSdk('mini app mount', () => {
    if (!miniApp.isMounted() && miniApp.mount.isAvailable()) miniApp.mount();
  });
  safeSdk('theme color scheme', () => {
    const isDark = themeParams.isDark();
    setTelegramColorScheme(isDark);
    syncMiniAppChrome(isDark);
  });
  safeSdk('theme scheme subscription', () => {
    removeThemeSchemeChange ??= themeParams.isDark.sub((nextIsDark) => {
      setTelegramColorScheme(nextIsDark);
      syncMiniAppChrome(nextIsDark);
    });
  });

  safeSdk('main button mount', () => {
    if (!mainButton.isMounted() && mainButton.mount.isAvailable()) mainButton.mount();
  });
  safeSdk('back button mount', () => {
    if (!backButton.isMounted() && backButton.isSupported() && backButton.mount.isAvailable()) {
      backButton.mount();
    }
  });
  syncNativeControls();
  safeSdk('ready', () => {
    if (!readySent && miniApp.ready.isAvailable()) {
      miniApp.ready();
      readySent = true;
    }
  });

  safeSdk('viewport setup', () => {
    if (viewport.isMounted()) {
      if (!viewport.isCssVarsBound() && viewport.bindCssVars.isAvailable()) viewport.bindCssVars();
      if (!viewportExpanded && viewport.expand.isAvailable()) {
        viewport.expand();
        viewportExpanded = true;
      }
      return;
    }
    if (!viewport.mount.isAvailable() || viewportMounting !== null) return;
    viewportMounting = viewport.mount({ timeout: VIEWPORT_MOUNT_TIMEOUT_MS })
      .then(() => {
        safeSdk('viewport CSS variables', () => {
          if (!viewport.isCssVarsBound() && viewport.bindCssVars.isAvailable()) {
            viewport.bindCssVars();
          }
        });
        safeSdk('viewport expand', () => {
          if (!viewportExpanded && viewport.expand.isAvailable()) {
            viewport.expand();
            viewportExpanded = true;
          }
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown SDK error';
        console.warn(`[telegram] viewport mount failed: ${message}`);
      })
      .finally(() => {
        viewportMounting = null;
      });
  });
}

export function isTelegramSetupComplete(): boolean {
  const mainButtonReady =
    !sdkAvailable('main button availability probe', mainButton.mount.isAvailable) ||
    sdkAvailable('main button mounted probe', mainButton.isMounted);
  const backButtonRequired =
    sdkAvailable('back button support probe', backButton.isSupported) &&
    sdkAvailable('back button availability probe', backButton.mount.isAvailable);
  const backButtonReady =
    !backButtonRequired || sdkAvailable('back button mounted probe', backButton.isMounted);
  return (
    initialized &&
    initDataRestored &&
    readySent &&
    viewportExpanded &&
    mainButtonSynced &&
    backButtonSynced &&
    sdkAvailable('mini app mounted probe', miniApp.isMounted) &&
    sdkAvailable('viewport mounted probe', viewport.isMounted) &&
    mainButtonReady &&
    backButtonReady
  );
}

export function createTelegramAdapter(): PlatformAdapter {
  initializeTelegram();
  let verifiedRawInitData: string | null = null;
  let verifiedTelegramId: string | null = null;
  let observedRawInitData: string | null | undefined;
  let observedSessionFingerprint: string | undefined;
  let nextSessionFingerprint = 0;

  const invalidateVerifiedSession = (): void => {
    verifiedRawInitData = null;
    verifiedTelegramId = null;
  };

  const readRawInitData = (): string | null => {
    let rawInitData: string | undefined;
    safeSdk('read raw init data', () => {
      rawInitData = retrieveRawInitData();
    });
    const observed = rawInitData && rawInitData.length > 0 ? rawInitData : null;
    if (observed !== observedRawInitData) {
      observedRawInitData = observed;
      observedSessionFingerprint = observed === null
        ? undefined
        : `tma-session-${++nextSessionFingerprint}`;
    }
    return observed;
  };

  const assertRawSessionUnchanged = (
    expectedRawInitData: string,
    requireVerifiedSession = false,
  ): void => {
    if (
      readRawInitData() === expectedRawInitData &&
      (!requireVerifiedSession || verifiedRawInitData === expectedRawInitData)
    ) {
      return;
    }
    invalidateVerifiedSession();
    throw new TelegramApiRequestError(425, 'telegram_session_changed');
  };

  const requestJson = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    requireVerifiedSession = true,
  ): Promise<{ readonly value: unknown; readonly rawInitData: string }> => {
    const rawInitData = readRawInitData();
    if (rawInitData === null) {
      if (requireVerifiedSession) {
        invalidateVerifiedSession();
        throw new TelegramApiRequestError(425, 'telegram_session_changed');
      }
      throw new TelegramApiRequestError(401, 'init_data_unavailable');
    }
    if (requireVerifiedSession && rawInitData !== verifiedRawInitData) {
      invalidateVerifiedSession();
      throw new TelegramApiRequestError(425, 'telegram_session_changed');
    }
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `tma ${rawInitData}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
    } catch (error: unknown) {
      if (requireVerifiedSession) assertRawSessionUnchanged(rawInitData, true);
      throw error;
    }
    if (requireVerifiedSession) assertRawSessionUnchanged(rawInitData, true);
    if (!response.ok) {
      let error: TelegramApiRequestError;
      try {
        error = await parseTelegramApiError(response);
      } finally {
        if (requireVerifiedSession) assertRawSessionUnchanged(rawInitData, true);
      }
      throw error;
    }
    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      if (requireVerifiedSession) assertRawSessionUnchanged(rawInitData, true);
      throw new TelegramApiResponseError();
    }
    if (requireVerifiedSession) assertRawSessionUnchanged(rawInitData, true);
    return { value, rawInitData };
  };

  return {
    isTelegram: true,

    getCurrentUser() {
      return getCurrentTelegramUser();
    },

    getSessionFingerprint() {
      readRawInitData();
      return observedSessionFingerprint;
    },

    haptic(kind) {
      safeSdk('haptic', () => {
        if (kind === 'light' && hapticFeedback.impactOccurred.isAvailable()) {
          hapticFeedback.impactOccurred('light');
        } else if (kind !== 'light' && hapticFeedback.notificationOccurred.isAvailable()) {
          hapticFeedback.notificationOccurred(kind);
        }
      });
    },

    copyText: copyTextToClipboard,

    mainButton: {
      get supported() {
        return (
          sdkAvailable('main button support probe', mainButton.mount.isAvailable) &&
          sdkAvailable('main button params support probe', mainButton.setParams.isAvailable) &&
          sdkAvailable('main button listener support probe', mainButton.onClick.isAvailable)
        );
      },
      show(config) {
        activeMainButtonAction = null;
        desiredMainButton = config;
        syncMainButtonAfterIntent();
      },
      hide() {
        desiredMainButton = null;
        syncMainButtonAfterIntent();
      },
    },

    armBack(onBack) {
      activeBackAction = null;
      desiredBackAction = onBack;
      syncBackButtonAfterIntent();
      return () => {
        if (desiredBackAction !== onBack) return;
        desiredBackAction = null;
        syncBackButtonAfterIntent();
      };
    },

    async loadLaunchState(signal) {
      if (readRawInitData() === null) return null;
      const response = await requestJson('/api/tma/bootstrap', {}, signal, false);
      const clientNowISO = new Date().toISOString();
      const launch = parseLaunchState(response.value, clientNowISO);
      if (launch.bank?.mode === 'server') await assertServerRevisionDigest(launch.bank);
      // A bootstrap response that raced a Telegram account switch must not
      // authorize mutations for the raw session that is no longer active.
      assertRawSessionUnchanged(response.rawInitData);
      verifiedRawInitData = response.rawInitData;
      verifiedTelegramId = launch.telegramId;
      return launch;
    },

    async importBankState(request, signal) {
      if (
        !isClientMutationId(request.importId) ||
        (request.stateVersion !== 4 && request.stateVersion !== 5)
      ) {
        throw new TelegramApiResponseError();
      }
      const expectedTelegramId = verifiedTelegramId;
      if (expectedTelegramId === null) {
        throw new TelegramApiRequestError(425, 'telegram_session_changed');
      }
      if (request.state.profile.telegramId !== expectedTelegramId) {
        throw new TelegramApiResponseError();
      }
      const response = await requestJson('/api/tma/bank-import', request, signal);
      const clientNowISO = new Date().toISOString();
      const parsed = parseBankImportResponse(
        response.value,
        expectedTelegramId,
        clientNowISO,
      );
      try {
        await assertServerRevisionDigest(parsed);
      } catch (error: unknown) {
        assertRawSessionUnchanged(response.rawInitData, true);
        throw error;
      }
      assertRawSessionUnchanged(response.rawInitData, true);
      return parsed;
    },

    async executeBankCommand(command, clientMutationId, signal) {
      if (!isClientMutationId(clientMutationId)) {
        throw new TelegramApiResponseError();
      }
      const expectedTelegramId = verifiedTelegramId;
      if (expectedTelegramId === null) {
        throw new TelegramApiRequestError(425, 'telegram_session_changed');
      }
      const response = await requestJson(
        '/api/tma/bank-command',
        { version: 1, clientMutationId, command },
        signal,
      );
      const clientNowISO = new Date().toISOString();
      const parsed = parseBankCommandResponse(
        response.value,
        expectedTelegramId,
        clientNowISO,
      );
      try {
        await assertServerRevisionDigest(parsed);
      } catch (error: unknown) {
        assertRawSessionUnchanged(response.rawInitData, true);
        throw error;
      }
      assertRawSessionUnchanged(response.rawInitData, true);
      return parsed;
    },

    async refreshBankRates(clientMutationId, signal) {
      if (!isClientMutationId(clientMutationId)) {
        throw new TelegramApiResponseError();
      }
      const expectedTelegramId = verifiedTelegramId;
      if (expectedTelegramId === null) {
        throw new TelegramApiRequestError(425, 'telegram_session_changed');
      }
      const response = await requestJson(
        '/api/tma/bank-rates',
        { version: 1, clientMutationId },
        signal,
      );
      const clientNowISO = new Date().toISOString();
      const parsed = parseBankRatesRefreshResponse(
        response.value,
        expectedTelegramId,
        clientNowISO,
      );
      try {
        await assertServerRevisionDigest(parsed);
      } catch (error: unknown) {
        assertRawSessionUnchanged(response.rawInitData, true);
        throw error;
      }
      assertRawSessionUnchanged(response.rawInitData, true);
      return parsed;
    },
  };
}
