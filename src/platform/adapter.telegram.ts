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
import { SUPPORTED_CURRENCIES } from '@/domain/currency';
import { isAppLocale } from '@/i18n/catalog';
import type { LaunchPreferences, PlatformAdapter, PlatformUser } from './types';
import { copyTextToClipboard } from './clipboard';

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
const MAX_DISPLAY_NAME_CODE_POINTS = 48;
const DISALLOWED_DISPLAY_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNICODE_SEPARATORS = /\p{Z}+/gu;
const forwardMainButtonClick = () => activeMainButtonAction?.();
const forwardBackButtonClick = () => activeBackAction?.();

class TelegramPreferencesRequestError extends Error {
  readonly retryable: boolean;

  constructor(status: number) {
    super(`Telegram preferences request failed (${status})`);
    this.name = 'TelegramPreferencesRequestError';
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

class TelegramPreferencesResponseError extends TypeError {
  readonly retryable = false;

  constructor() {
    super('Invalid Telegram preferences response');
    this.name = 'TelegramPreferencesResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeDisplayName(value: string): string | null {
  if (DISALLOWED_DISPLAY_NAME_CHARACTERS.test(value)) return null;
  const normalized = value
    .normalize('NFC')
    .replace(UNICODE_SEPARATORS, ' ')
    .trim();
  if (normalized === '' || [...normalized].length > MAX_DISPLAY_NAME_CODE_POINTS) return null;
  return normalized;
}

export function normalizeTelegramId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}

export function parseLaunchPreferences(value: unknown): LaunchPreferences {
  if (!isRecord(value)) throw new TypeError('Invalid Telegram preferences response');
  const displayName = value.displayName;
  const telegramId = value.telegramId;
  const revisionEpoch = value.revisionEpoch;
  const revision = value.revision;
  const primaryCurrency = value.primaryCurrency;
  const normalizedDisplayName =
    typeof displayName === 'string' ? normalizeDisplayName(displayName) : null;
  const validName = normalizedDisplayName !== null && normalizedDisplayName === displayName;
  const validCurrency =
    typeof primaryCurrency === 'string' &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(primaryCurrency);

  if (
    value.version !== 1 ||
    typeof revisionEpoch !== 'string' ||
    !/^[0-9a-f]{32}$/.test(revisionEpoch) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1 ||
    !isAppLocale(value.locale) ||
    !validCurrency ||
    !validName ||
    typeof telegramId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(telegramId)
  ) {
    throw new TypeError('Invalid Telegram preferences response');
  }

  return {
    version: 1,
    revisionEpoch,
    revision: revision as number,
    locale: value.locale,
    primaryCurrency: primaryCurrency as LaunchPreferences['primaryCurrency'],
    displayName,
    telegramId,
  };
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

  return {
    isTelegram: true,

    getCurrentUser() {
      return getCurrentTelegramUser();
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

    async loadLaunchPreferences(signal) {
      let rawInitData: string | undefined;
      safeSdk('read raw init data', () => {
        rawInitData = retrieveRawInitData();
      });
      if (!rawInitData) return null;

      const response = await fetch('/api/tma/bootstrap', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `tma ${rawInitData}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new TelegramPreferencesRequestError(response.status);
      try {
        return parseLaunchPreferences(await response.json());
      } catch {
        throw new TelegramPreferencesResponseError();
      }
    },
  };
}
