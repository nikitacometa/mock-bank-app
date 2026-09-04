import { useEffect, useRef, useState } from 'react';
import { useBankStore } from '@/store/bankStore';
import { useUiStore } from '@/store/uiStore';
import { balanceOf } from '@/domain/ledger';
import { formatMoney } from '@/domain/money';
import { useI18n } from '@/i18n';
import { BankCard } from '../BankCard';
import { CurrencyBadge } from '../CurrencyBadge';
import { localizeDemoText } from '../format';

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
  const { locale, t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ pointerId: -1, startX: 0, startScroll: 0, moved: false });
  const [activeCard, setActiveCard] = useState(0);

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
      const items = [...track.querySelectorAll<HTMLElement>('[data-card]')];
      const closest = items.reduce(
        (best, el, index) => {
          const distance = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
          return distance < best.distance ? { index, distance } : best;
        },
        { index: 0, distance: Number.POSITIVE_INFINITY },
      );
      setActiveCard(closest.index);
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

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    const track = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: track.scrollLeft,
      moved: false,
    };
    track.setPointerCapture(event.pointerId);
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    dragRef.current.pointerId = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      finishDrag(event);
      return;
    }
    const delta = event.clientX - drag.startX;
    if (Math.abs(delta) > 5) drag.moved = true;
    if (drag.moved) {
      event.preventDefault();
      event.currentTarget.scrollLeft = drag.startScroll - delta;
    }
  };

  return (
    <div className="pb-28" style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}>
      <header className="px-5 py-2.5">
        <h1 className="text-[1.375rem] font-semibold tracking-tight">{t('cards.title')}</h1>
      </header>

      <div
        ref={trackRef}
        className="scrollbar-none mt-2 flex snap-x snap-mandatory select-none gap-4 overflow-x-auto px-8 py-4"
        style={{ perspective: '900px', touchAction: 'pan-x' }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
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
                aria-label={t('cards.cardLabel', { last4: card.last4 })}
              >
                <BankCard card={card} />
              </button>
              <div className="mt-3 flex items-center justify-center gap-2 px-1 text-left">
                {account && <CurrencyBadge currency={account.currency} size={30} />}
                <div>
                  <div className="text-[0.875rem]">
                    {localizeDemoText(account?.name, locale)}
                  </div>
                  <div className="num mt-0.5 text-[0.75rem] text-ink-3">
                    {account
                      ? formatMoney(balanceOf({ transactions }, account.id), account.currency, locale)
                      : ''}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {t('cards.position', { current: activeCard + 1, total: cards.length })}
      </span>
      <div className="mt-1 flex justify-center">
        {cards.map((card, index) => (
          <button
            key={card.id}
            className="flex size-11 items-center justify-center"
            aria-label={t('cards.show', { index: index + 1 })}
            aria-current={activeCard === index}
            onClick={() => {
              const cardElement = trackRef.current?.querySelectorAll<HTMLElement>('[data-card]')[index];
              cardElement?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }}
          >
            <span
              className={`h-1.5 rounded-full transition-all ${
                activeCard === index ? 'w-5 bg-ivory' : 'w-1.5 bg-line'
              }`}
            />
          </button>
        ))}
      </div>

      <p className="mt-2 px-8 text-center text-[0.8125rem] text-ink-3">
        {t('cards.hint')}
      </p>
    </div>
  );
}
