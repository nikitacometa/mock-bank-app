import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformAdapter } from './types';
import { webAdapter } from './adapter.web';

const PlatformContext = createContext<PlatformAdapter>(webAdapter);

export function PlatformProvider({ children }: { children: ReactNode }) {
  // Phase 2: detect Telegram and provide adapter.telegram.ts here.
  return <PlatformContext.Provider value={webAdapter}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformAdapter {
  return useContext(PlatformContext);
}
