import type { Card } from '@/domain/types';
import { APP_NAME } from '@/app/config';
import { CometMark, IconFreeze } from './icons';

const FACES: Record<Card['design'], { bg: string; ink: string; dim: string; trail: string }> = {
  midnight: {
    bg: 'radial-gradient(120% 160% at 85% -20%, oklch(0.28 0.035 262) 0%, oklch(0.155 0.018 258) 55%)',
    ink: 'oklch(0.93 0.006 252)',
    dim: 'oklch(0.93 0.006 252 / 55%)',
    trail: 'oklch(0.93 0.006 252 / 10%)',
  },
  ivory: {
    bg: 'radial-gradient(130% 170% at 15% -30%, oklch(0.97 0.02 90) 0%, oklch(0.88 0.028 82) 60%)',
    ink: 'oklch(0.23 0.015 260)',
    dim: 'oklch(0.23 0.015 260 / 55%)',
    trail: 'oklch(0.23 0.015 260 / 8%)',
  },
  mint: {
    bg: 'radial-gradient(120% 160% at 80% -20%, oklch(0.34 0.06 168) 0%, oklch(0.19 0.03 170) 60%)',
    ink: 'oklch(0.9 0.04 163)',
    dim: 'oklch(0.9 0.04 163 / 55%)',
    trail: 'oklch(0.9 0.04 163 / 10%)',
  },
};

function BrandMark({ brand, color }: { brand: Card['brand']; color: string }) {
  if (brand === 'visa') {
    return (
      <span className="text-[0.9375rem] font-bold tracking-[0.08em] italic" style={{ color }}>
        VISA
      </span>
    );
  }
  return (
    <span className="flex" aria-label="Mastercard">
      <span className="size-5 rounded-full" style={{ background: color, opacity: 0.85 }} />
      <span className="-ml-2 size-5 rounded-full" style={{ background: color, opacity: 0.45 }} />
    </span>
  );
}

/** One card face — used by the carousel and the detail sheet. */
export function BankCard({ card, className = '' }: { card: Card; className?: string }) {
  const face = FACES[card.design];
  const frozen = card.status === 'frozen';
  return (
    <div
      className={`relative aspect-[1.586] w-full overflow-hidden rounded-card select-none ${className}`}
      style={{ background: face.bg, color: face.ink }}
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 340 214"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <path d="M-30 210 C 110 190, 240 110, 370 -20" stroke={face.trail} strokeWidth="52" strokeLinecap="round" />
        <path d="M40 224 C 160 190, 260 130, 380 30" stroke={face.trail} strokeWidth="16" strokeLinecap="round" />
      </svg>

      <div className="absolute inset-0 flex flex-col justify-between p-5" style={{ opacity: frozen ? 0.35 : 1 }}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold tracking-tight">
            <CometMark size={16} /> {APP_NAME}
          </span>
          <BrandMark brand={card.brand} color={face.ink} />
        </div>
        <div className="flex items-end justify-between">
          <div>
            <div className="num text-[1.0625rem]">·· {card.last4}</div>
            <div className="mt-1 text-[0.6875rem] tracking-[0.08em]" style={{ color: face.dim }}>
              {card.holder}
            </div>
          </div>
          <div className="num text-[0.8125rem]" style={{ color: face.dim }}>
            {card.expiry}
          </div>
        </div>
      </div>

      {frozen && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 backdrop-blur-[2px]">
          <IconFreeze size={18} />
          <span className="text-[0.9375rem] font-medium">Заморожена</span>
        </div>
      )}
    </div>
  );
}
