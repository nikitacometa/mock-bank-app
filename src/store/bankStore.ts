import { create } from 'zustand';
import type { BankState } from '@/domain/types';
import { applyTransfer, type TransferInput, type TransferOutcome } from '@/domain/transfer';
import { applySettleAll } from '@/domain/interest';
import { buildSeed } from '@/domain/seed';
import { assertLedger } from '@/domain/invariants';
import { loadPersisted, savePersisted, onCrossTabChange } from './persistence';

interface BankStore extends BankState {
  /** True when persisted state failed validation and was reseeded. */
  recoveredFromCorruption: boolean;

  transfer(input: Omit<TransferInput, 'nowISO'>): TransferOutcome;
  settleNow(): void;
  toggleCardFreeze(cardId: string): void;
  resetDemo(): void;
}

function initialState(): { state: BankState; recovered: boolean } {
  const loaded = loadPersisted();
  if (loaded.kind === 'ok') return { state: loaded.state, recovered: false };
  return { state: buildSeed(new Date().toISOString()), recovered: loaded.kind === 'corrupted' };
}

const init = initialState();

export const useBankStore = create<BankStore>()((set, get) => {
  /** Apply a BankState transition atomically + persist + dev-invariant. */
  const commit = (next: BankState) => {
    assertLedger(next);
    set(next);
    savePersisted(next);
  };

  const pickBankState = (s: BankStore): BankState => ({
    accounts: s.accounts,
    transactions: s.transactions,
    cards: s.cards,
    contacts: s.contacts,
    profile: s.profile,
    nextSeq: s.nextSeq,
    recentTransferIds: s.recentTransferIds,
  });

  return {
    ...init.state,
    recoveredFromCorruption: init.recovered,

    transfer(input) {
      const outcome = applyTransfer(pickBankState(get()), {
        ...input,
        nowISO: new Date().toISOString(),
      });
      if (outcome.ok) commit(outcome.state);
      return outcome;
    },

    settleNow() {
      const before = pickBankState(get());
      const after = applySettleAll(before, new Date().toISOString());
      if (after !== before) commit(after);
    },

    toggleCardFreeze(cardId) {
      const s = pickBankState(get());
      commit({
        ...s,
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, status: c.status === 'active' ? 'frozen' : 'active' } : c,
        ),
      });
    },

    resetDemo() {
      commit(buildSeed(new Date().toISOString()));
      set({ recoveredFromCorruption: false });
    },
  };
});

// First-run persistence + cross-tab subscription (module scope: one per tab).
if (typeof window !== 'undefined') {
  if (init.recovered || loadPersisted().kind === 'empty') {
    savePersisted(init.state);
  }
  onCrossTabChange((state) => useBankStore.setState(state));
}
