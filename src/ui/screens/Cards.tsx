import { useEffect, useRef } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { balanceOf } from '@/domain/ledger';
import { formatMoney } from '@/domain/money';
import { BankCard } from '../BankCard';

/**
 * Card switching is native CSS scroll-snap (zero JS in the gesture path).
 * Motion layers, per the gesture-conflict verdict in docs/spec.md §6 M4:
 *  - touch: scroll-linked parallax only (no pointer tilt fighting the scroll)
 *  - mouse: hover tilt on the focused card
 */
export function Cards() {
  const cards = useBankStore((s) => s.cards);
  const accounts = useBankStore((s) => s.accounts);
  const transactions = useBankStore((s) => s.transactions);
  const openSheet = useUiStore((s) => s.openSheet);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let raf = 0;
    const update = () => {
      const mid = track.scrollLeft + track.clientWidth / 2;
      for (const el of track.querySelectorAll<HTMLElement>('[data-card]')) {
        const r = (el.offsetLeft + el.offsetWidth / 2 - mid) / track.clientWidth; // ≈ -1..1
        el.style.setProperty('--ry', `${(-r * 7).toFixed(2)}deg`);
        el.style.setProperty('--s', `${(1 - Math.min(0.07, Math.abs(r) * 0.09)).toFixed(3)}`);
      }
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [cards.length]);

  const onTilt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--mrx', `${(-y * 7).toFixed(2)}deg`);
    el.style.setProperty('--mry', `${(x * 9).toFixed(2)}deg`);
  };
  const resetTilt = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty('--mrx', '0deg');
    e.currentTarget.style.setProperty('--mry', '0deg');
  };

  return (
    <div className="pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="px-5 py-2.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight">Карты</h1>
      </header>

      <div
        ref={trackRef}
        className="scrollbar-none mt-2 flex snap-x snap-mandatory gap-4 overflow-x-auto px-8 py-4"
        style={{ perspective: '900px' }}
      >
        {cards.map((card) => {
          const account = accounts.find((a) => a.id === card.accountId);
          return (
            <div
              key={card.id}
              data-card
              className="w-[82%] shrink-0 snap-center transition-transform duration-100"
              style={{
                transform:
                  'rotateY(calc(var(--ry, 0deg) + var(--mry, 0deg))) rotateX(var(--mrx, 0deg)) scale(var(--s, 1))',
                transformStyle: 'preserve-3d',
              }}
              onPointerMove={onTilt}
              onPointerLeave={resetTilt}
            >
              <button
                className="block w-full text-left"
                onClick={() => openSheet({ kind: 'cardDetail', cardId: card.id })}
                aria-label={`Карта ·· ${card.last4}`}
              >
                <BankCard card={card} />
              </button>
              <div className="mt-3 px-1 text-center">
                <div className="text-[0.9375rem]">{account?.name}</div>
                <div className="num mt-0.5 text-[0.8125rem] text-ink-3">
                  {account ? formatMoney(balanceOf({ transactions }, account.id)) : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-6 px-8 text-center text-[0.8125rem] text-ink-3">
        Нажми на карту — реквизиты и заморозка
      </p>
    </div>
  );
}
