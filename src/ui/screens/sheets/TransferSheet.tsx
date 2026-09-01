import { useMemo, useRef, useState } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { usePlatform } from '@/platform/usePlatform';
import { balanceOf } from '@/domain/ledger';
import { formatMoney, parseAmountInput } from '@/domain/money';
import { Sheet } from '../../primitives/Sheet';
import { PrimaryAction } from '../../primitives/PrimaryAction';
import { Avatar } from '../../primitives/Avatar';
import { IconBackspace } from '../../icons';

type Mode = 'contact' | 'own';

/** "12345,6" → "12 345,6" for the draft amount display. */
function fmtDraft(raw: string): string {
  const [int, dec] = raw.split(',');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return dec !== undefined ? `${grouped},${dec}` : grouped;
}

function SuccessScene({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-4 px-5 pt-6 pb-10">
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden>
        <circle
          cx="36" cy="36" r="30" stroke="var(--color-mint)" strokeWidth="3"
          strokeDasharray="189" strokeDashoffset="189" strokeLinecap="round"
          style={{ animation: 'draw-stroke 420ms var(--ease-out-premium) forwards' }}
        />
        <path
          d="m24 37.5 8.5 8.5L48.5 29" stroke="var(--color-mint)" strokeWidth="4"
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray="36" strokeDashoffset="36"
          style={{ animation: 'draw-stroke 260ms var(--ease-out-premium) 360ms forwards' }}
        />
      </svg>
      <div className="text-[1.0625rem] font-medium">{text}</div>
    </div>
  );
}

export function TransferSheet({ initialMode }: { initialMode: Mode }) {
  const accounts = useBankStore((s) => s.accounts);
  const contacts = useBankStore((s) => s.contacts);
  const transactions = useBankStore((s) => s.transactions);
  const transfer = useBankStore((s) => s.transfer);
  const closeSheet = useUiStore((s) => s.closeSheet);
  const activeAccountId = useUiStore((s) => s.activeAccountId);
  const platform = usePlatform();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [raw, setRaw] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  // Own transfer: default = top up the active account from the other one.
  const other = accounts.find((a) => a.id !== activeAccountId)?.id ?? accounts[0].id;
  const [ownFrom, setOwnFrom] = useState(other);
  const [ownTo, setOwnTo] = useState(activeAccountId);
  const [contactFrom, setContactFrom] = useState(activeAccountId);
  const [success, setSuccess] = useState<string | null>(null);
  // Idempotency key: minted on first submit, stable across a double tap.
  const clientTransferId = useRef<string | null>(null);

  const sortedContacts = useMemo(
    () =>
      [...contacts].sort((a, b) => {
        if (a.lastTransferAt && b.lastTransferAt) return b.lastTransferAt.localeCompare(a.lastTransferAt);
        if (a.lastTransferAt) return -1;
        if (b.lastTransferAt) return 1;
        return a.name.localeCompare(b.name, 'ru');
      }),
    [contacts],
  );

  const fromId = mode === 'own' ? ownFrom : contactFrom;
  const available = balanceOf({ transactions }, fromId);
  const amount = raw === '' ? null : parseAmountInput(raw);
  const insufficient = amount !== null && amount > available;
  const recipientOk = mode === 'own' ? ownFrom !== ownTo : contactId !== null;
  const canSubmit = amount !== null && !insufficient && recipientOk && !success;

  const tap = (key: string) => {
    platform.haptic('light');
    setRaw((r) => {
      if (key === '⌫') return r.slice(0, -1);
      if (key === ',') {
        if (r.includes(',')) return r;
        return r === '' ? '0,' : r + ',';
      }
      const [int, dec] = r.split(',');
      if (dec !== undefined) return dec.length >= 2 ? r : r + key;
      if (int.length >= 7) return r;
      if (int === '0') return key; // no leading zeros
      return r + key;
    });
  };

  const submit = () => {
    if (!canSubmit || amount === null) return;
    clientTransferId.current ??= crypto.randomUUID();
    const key = clientTransferId.current;
    const outcome = transfer(
      mode === 'own'
        ? { fromAccountId: ownFrom, toAccountId: ownTo, amountMinor: amount, clientTransferId: key }
        : { fromAccountId: contactFrom, toContactId: contactId!, amountMinor: amount, clientTransferId: key },
    );
    if (outcome.ok) {
      platform.haptic('success');
      const target =
        mode === 'own'
          ? accounts.find((a) => a.id === ownTo)?.name
          : contacts.find((c) => c.id === contactId)?.name;
      setSuccess(`${formatMoney(amount)} → ${target}`);
      setTimeout(closeSheet, 1250);
    } else {
      platform.haptic('warning');
    }
  };

  const accountPill = (id: string, current: string, set: (id: string) => void) => {
    const a = accounts.find((x) => x.id === id)!;
    return (
      <button
        key={id}
        className={`rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
          id === current ? 'bg-ink font-medium text-bg' : 'bg-surface-2 text-ink-2'
        }`}
        onClick={() => set(id)}
      >
        {a.name}
      </button>
    );
  };

  return (
    <Sheet open onClose={closeSheet} title={success ? 'Готово' : 'Перевод'}>
      {success ? (
        <SuccessScene text={success} />
      ) : (
        <div className="px-5 pb-2">
          <div className="mt-1 flex gap-1.5">
            {(['contact', 'own'] as const).map((m) => (
              <button
                key={m}
                className={`rounded-full px-3.5 py-1.5 text-[0.8125rem] transition-colors ${
                  mode === m ? 'bg-surface-2 text-ink' : 'text-ink-3'
                }`}
                onClick={() => setMode(m)}
              >
                {m === 'contact' ? 'Человеку' : 'Между своими'}
              </button>
            ))}
          </div>

          {mode === 'contact' ? (
            <div className="scrollbar-none -mx-5 mt-4 flex gap-4 overflow-x-auto px-5">
              {sortedContacts.map((c) => (
                <button
                  key={c.id}
                  className="flex w-14 shrink-0 flex-col items-center gap-1.5"
                  onClick={() => setContactId(c.id)}
                >
                  <span
                    className={`rounded-full transition-shadow ${
                      contactId === c.id ? 'ring-2 ring-ivory ring-offset-2 ring-offset-surface' : ''
                    }`}
                  >
                    <Avatar name={c.name} initials={c.initials} size={48} />
                  </span>
                  <span className={`text-[0.75rem] ${contactId === c.id ? 'text-ink' : 'text-ink-3'}`}>
                    {c.name}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-2">
              <div className="flex flex-1 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 text-[0.75rem] text-ink-3">Со</span>
                  <div className="flex gap-1.5">{accounts.map((a) => accountPill(a.id, ownFrom, (id) => { setOwnFrom(id); if (id === ownTo) setOwnTo(accounts.find((x) => x.id !== id)!.id); }))}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-6 text-[0.75rem] text-ink-3">На</span>
                  <div className="flex gap-1.5">{accounts.map((a) => accountPill(a.id, ownTo, (id) => { setOwnTo(id); if (id === ownFrom) setOwnFrom(accounts.find((x) => x.id !== id)!.id); }))}</div>
                </div>
              </div>
            </div>
          )}

          {mode === 'contact' && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[0.75rem] text-ink-3">Списать с</span>
              <div className="flex gap-1.5">{accounts.map((a) => accountPill(a.id, contactFrom, setContactFrom))}</div>
            </div>
          )}

          <div className="mt-5 text-center">
            <div className="num text-[2.25rem] leading-none font-medium">
              {raw === '' ? <span className="text-ink-3">0</span> : fmtDraft(raw)}
              <span className="text-ink-3"> ₽</span>
            </div>
            <div className={`mt-2 text-[0.8125rem] ${insufficient ? 'text-coral' : 'text-ink-3'}`}>
              {insufficient && amount !== null
                ? `Не хватает ${formatMoney(amount - available)}`
                : `Доступно ${formatMoney(available)}`}
            </div>
          </div>

          <div className="mx-auto mt-4 grid max-w-72 grid-cols-3 gap-1">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'].map((k) => (
              <button
                key={k}
                aria-label={k === '⌫' ? 'Стереть' : k}
                className="num flex h-13 items-center justify-center rounded-btn text-[1.375rem] transition-colors active:bg-surface-2"
                onClick={() => tap(k)}
              >
                {k === '⌫' ? <IconBackspace size={22} className="text-ink-2" /> : k}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <PrimaryAction
              text={amount !== null && recipientOk && !insufficient ? `Перевести ${formatMoney(amount)}` : 'Перевести'}
              onClick={submit}
              disabled={!canSubmit}
            />
          </div>
        </div>
      )}
    </Sheet>
  );
}
