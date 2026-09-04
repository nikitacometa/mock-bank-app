import type { ReactNode, SVGProps } from 'react';
import { CategoryIcon } from './icons';

type MarkProps = SVGProps<SVGSVGElement>;

type MerchantId =
  | 'chatgpt'
  | 'spotify'
  | 'yandex-go'
  | 'yandex-eats'
  | 'airbnb'
  | 'booking'
  | 'gopay'
  | 'gojek'
  | 'apple-store'
  | 'airasia'
  | 'scoot'
  | '12go'
  | '7-eleven'
  | 'grab'
  | 'lazada'
  | 'tokopedia'
  | 'uniqlo'
  | 'qazaq-energy';

type AvatarTone = 'ink' | 'ivory' | 'ivory-soft' | 'neutral';

interface MerchantMark {
  readonly id: MerchantId;
  readonly tone: AvatarTone;
  readonly matches: (normalized: string, compact: string) => boolean;
  readonly glyph: (props: MarkProps) => ReactNode;
}

function markProps(props: MarkProps): MarkProps {
  return {
    viewBox: '0 0 28 28',
    width: 28,
    height: 28,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false',
    'aria-hidden': true,
    ...props,
  };
}

function ChatGptMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M13.9 4.1a4.7 4.7 0 0 1 8.4 3.4v3.1a4.7 4.7 0 0 1 1.5 8.9l-2.7 1.6a4.7 4.7 0 0 1-7 5.4l-2.7-1.6A4.7 4.7 0 0 1 3 21.5v-3.1a4.7 4.7 0 0 1-1.5-8.9l2.7-1.6a4.7 4.7 0 0 1 7-5.4l2.7 1.6Z" />
      <path d="m8.1 10.6 5.8-3.3 5.8 3.3v6.7l-5.8 3.4-5.8-3.4Z" />
      <path d="m8.1 10.6 5.8 3.4 5.8-3.4M13.9 14v6.7" opacity="0.72" />
    </svg>
  );
}

function SpotifyMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <circle cx="14" cy="14" r="10" fill="currentColor" stroke="none" />
      <path d="M8.2 11.1c4.4-1.2 8.3-.8 12.1 1.1M9 14.7c3.7-.8 7-.4 10.3 1.3M9.8 18c3-.5 5.6-.1 8.3 1" stroke="var(--color-bg)" strokeWidth="1.55" />
    </svg>
  );
}

function YandexGoMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M8 5.5h5.4a4.7 4.7 0 0 1 0 9.4H11L8 20.7" strokeWidth="2.4" />
      <path d="M13 14.9 18.8 22M8 5.5l5 9.4" strokeWidth="2.4" />
      <path d="m18.1 7.2 3.6 3.6-3.6 3.6" opacity="0.62" />
    </svg>
  );
}

function YandexEatsMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M7.5 5.5v6.3a3 3 0 0 0 3 3h.5V22M10.5 5.5v5.2" strokeWidth="2" />
      <path d="M17.5 5.5v16.6M17.5 5.5c3 1.7 3.8 5.8 0 8.2" strokeWidth="2" />
    </svg>
  );
}

function AirbnbMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M14 5.2c-1.8 0-2.8 2.2-3.8 4.3L6.4 17c-1.9 3.7.4 5.5 2.5 4.4 2-1 3.5-3.4 5.1-6.2 1.6 2.8 3.1 5.2 5.1 6.2 2.1 1.1 4.4-.7 2.5-4.4l-3.8-7.5c-1-2.1-2-4.3-3.8-4.3Z" strokeWidth="2" />
      <path d="M10.9 14.2c.8-1.2 1.9-2 3.1-2s2.3.8 3.1 2" />
    </svg>
  );
}

function BookingMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M7.5 5.5h6.6c3.4 0 5.2 1.4 5.2 4 0 1.8-.9 3-2.6 3.6 2.2.5 3.3 1.9 3.3 4.2 0 3.2-2.2 5.2-6.3 5.2H7.5v-17Z" strokeWidth="2.2" />
      <path d="M8.2 13h6.2M23 20.7h.01" strokeWidth="2.5" />
    </svg>
  );
}

function GoPayMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M19.7 9.5A7.6 7.6 0 1 0 20 18h-6v-4.2h9.6" strokeWidth="2.2" />
      <path d="M18.3 6.4h4.2v4.2" opacity="0.62" />
    </svg>
  );
}

function GojekMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <circle cx="14" cy="15" r="2.2" fill="currentColor" stroke="none" />
      <path d="M8.6 13.2a5.7 5.7 0 0 1 10.8 0M5.3 10.6a9.5 9.5 0 0 1 17.4 0" strokeWidth="2.1" />
      <path d="M14 17.2V22" />
    </svg>
  );
}

function AppleStoreMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M17.2 8.7c-1.1 0-2 .6-2.7.6-.8 0-1.9-.6-3.1-.6-2.8.1-5.4 2.2-5.4 6.4 0 2.5.9 5 2.2 6.8 1 1.3 2.1 2.8 3.6 2.7 1.4-.1 2-.9 3.7-.9s2.2.9 3.8.9c1.5 0 2.5-1.4 3.5-2.7a10 10 0 0 0 1.5-3.1 4.5 4.5 0 0 1-2.7-4.1 4.7 4.7 0 0 1 2.2-3.9 4.8 4.8 0 0 0-3.8-2c-1.1-.1-2.1-.1-2.8-.1Z" fill="currentColor" stroke="none" />
      <path d="M17.8 4.3c.8-1 2.2-1.8 3.4-1.9.2 1.4-.4 2.7-1.2 3.7-.8 1-2.1 1.8-3.4 1.7-.2-1.3.4-2.6 1.2-3.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AirAsiaMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M5 21 13.8 5.5 23 21M9 16.8h9.8" strokeWidth="2.35" />
      <path d="M17.5 7.1c1.8-.4 3.4-.2 5 .7" opacity="0.62" />
    </svg>
  );
}

function ScootMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M21.3 8.5c-1.8-2.2-4.3-3.2-7.6-3.2-3.8 0-6.6 1.5-6.6 4 0 5.8 14.1 2.1 14.1 8.6 0 3-3.1 4.8-7.1 4.8-3.5 0-6.3-1.1-8.2-3.6" strokeWidth="2.25" />
      <path d="m4.7 6.4 2.1 1.4M21.2 20.2l2.1 1.4" opacity="0.58" />
    </svg>
  );
}

function TwelveGoMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M5.5 9.2 9 6.5V22M13 10.4c.2-2.5 1.6-4 4.1-4 2.4 0 4 1.4 4 3.7 0 1.8-1.3 3.3-3.3 5.1L13 19.5V22h8.7" strokeWidth="2.15" />
    </svg>
  );
}

function SevenElevenMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M5 6.5h11.2L9.3 22" strokeWidth="2.3" />
      <path d="M18.5 9.5V22M22.5 9.5V22" />
      <path d="M18 6h5" opacity="0.62" />
    </svg>
  );
}

function GrabMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M13.2 9.1A6.8 6.8 0 1 0 14 19h5.4v-5H14M13.2 12A3.8 3.8 0 1 0 14 16h2.4" strokeWidth="1.75" />
      <path d="M19.4 14h3.1v5" opacity="0.62" />
    </svg>
  );
}

function LazadaMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="m14 5 8.2 4.6v8.8L14 23l-8.2-4.6V9.6L14 5Z" strokeWidth="2" />
      <path d="M9.2 11.2c0-1.5 1.1-2.4 2.4-2.4 1.1 0 1.9.6 2.4 1.4.5-.8 1.3-1.4 2.4-1.4 1.3 0 2.4.9 2.4 2.4 0 2.3-2.4 3.9-4.8 5.8-2.4-1.9-4.8-3.5-4.8-5.8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TokopediaMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M6.5 10.5h15l-1.1 11H7.6l-1.1-11Z" strokeWidth="2" />
      <path d="M10 10.5V8.7a4 4 0 0 1 8 0v1.8" />
      <circle cx="11.4" cy="15.3" r="2.1" />
      <circle cx="16.6" cy="15.3" r="2.1" />
      <path d="m13.2 18 1.6 0" strokeWidth="2.2" />
    </svg>
  );
}

function UniqloMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <rect x="5" y="5" width="18" height="18" rx="1.5" strokeWidth="2" />
      <path d="M9 9v4.1c0 1.4.8 2.1 2 2.1s2-.7 2-2.1V9M16 9v6.2h3M9 18.7h4M16 18.7h3" strokeWidth="1.75" />
    </svg>
  );
}

function QazaqEnergyMark(props: MarkProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M19.9 19.9A8.5 8.5 0 1 1 22.5 14c0 2.3-.9 4.4-2.6 5.9L23 23" strokeWidth="2.2" />
      <path d="m14.9 7-4.2 7.2h3.8l-1.4 6.8 4.5-8h-3.9L14.9 7Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

const MERCHANT_MARKS: readonly MerchantMark[] = [
  {
    id: 'chatgpt',
    tone: 'ink',
    matches: (name, compact) => includesAny(name, ['chatgpt', 'openai']) || compact.includes('chatgpt'),
    glyph: ChatGptMark,
  },
  {
    id: 'spotify',
    tone: 'ivory-soft',
    matches: (name) => name.includes('spotify'),
    glyph: SpotifyMark,
  },
  {
    id: 'yandex-eats',
    tone: 'ivory',
    matches: (name, compact) =>
      includesAny(name, ['yandex eats', 'yandex food', 'яндекс еда']) || compact.includes('yandexeda'),
    glyph: YandexEatsMark,
  },
  {
    id: 'yandex-go',
    tone: 'neutral',
    matches: (name, compact) =>
      includesAny(name, ['yandex go', 'yandex taxi', 'яндекс go', 'яндекс такси']) || compact.includes('yandexgo'),
    glyph: YandexGoMark,
  },
  {
    id: 'airbnb',
    tone: 'ivory-soft',
    matches: (name, compact) => name.includes('airbnb') || compact.includes('airbnb'),
    glyph: AirbnbMark,
  },
  {
    id: 'booking',
    tone: 'neutral',
    matches: (name, compact) => name.includes('booking') || compact.includes('bookingcom'),
    glyph: BookingMark,
  },
  {
    id: 'gopay',
    tone: 'ivory-soft',
    matches: (_name, compact) => compact.includes('gopay'),
    glyph: GoPayMark,
  },
  {
    id: 'gojek',
    tone: 'ink',
    matches: (name, compact) => name.includes('gojek') || compact.includes('gojek'),
    glyph: GojekMark,
  },
  {
    id: 'apple-store',
    tone: 'ink',
    matches: (name, compact) =>
      includesAny(name, ['apple store', 'apple com bill']) || includesAny(compact, ['applecombill', 'itunescom']),
    glyph: AppleStoreMark,
  },
  {
    id: 'airasia',
    tone: 'neutral',
    matches: (name, compact) => name.includes('air asia') || compact.includes('airasia'),
    glyph: AirAsiaMark,
  },
  {
    id: 'scoot',
    tone: 'ivory-soft',
    matches: (name) => name.includes('scoot'),
    glyph: ScootMark,
  },
  {
    id: '12go',
    tone: 'ivory',
    matches: (name, compact) => includesAny(name, ['12go', '12 go']) || compact.includes('12goasia'),
    glyph: TwelveGoMark,
  },
  {
    id: '7-eleven',
    tone: 'neutral',
    matches: (name, compact) => includesAny(name, ['7 eleven', 'seven eleven']) || compact.includes('7eleven'),
    glyph: SevenElevenMark,
  },
  {
    id: 'grab',
    tone: 'ink',
    matches: (name) => name.includes('grab'),
    glyph: GrabMark,
  },
  {
    id: 'lazada',
    tone: 'ivory-soft',
    matches: (name) => name.includes('lazada'),
    glyph: LazadaMark,
  },
  {
    id: 'tokopedia',
    tone: 'neutral',
    matches: (name, compact) => name.includes('tokopedia') || compact.includes('tokopedia'),
    glyph: TokopediaMark,
  },
  {
    id: 'uniqlo',
    tone: 'ivory',
    matches: (name) => name.includes('uniqlo'),
    glyph: UniqloMark,
  },
  {
    id: 'qazaq-energy',
    tone: 'ivory-soft',
    matches: (name, compact) => name.includes('qazaq energy') || compact.includes('qazaqenergy'),
    glyph: QazaqEnergyMark,
  },
] as const;

const TONE_CLASS: Record<AvatarTone, string> = {
  ink: 'border-ink/80 bg-ink text-bg',
  ivory: 'border-ivory/75 bg-ivory text-bg',
  'ivory-soft': 'border-ivory/20 bg-ivory/[0.08] text-ivory',
  neutral: 'border-line/80 bg-surface-2 text-ink',
};

function normalizeMerchantName(value: string): { normalized: string; compact: string } {
  const normalized = value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
  return { normalized, compact: normalized.replaceAll(' ', '') };
}

function findMerchantMark(merchant: string | undefined): MerchantMark | undefined {
  if (!merchant) return undefined;
  const { normalized, compact } = normalizeMerchantName(merchant);
  return MERCHANT_MARKS.find(({ matches }) => matches(normalized, compact));
}

export function MerchantAvatar({
  merchant,
  category,
  isInterest = false,
}: {
  merchant?: string;
  category?: string;
  isInterest?: boolean;
}) {
  const mark = findMerchantMark(merchant);

  if (!mark) {
    return (
      <span
        aria-hidden="true"
        className={`flex size-11 shrink-0 items-center justify-center rounded-full ${
          isInterest ? 'bg-mint-dim text-mint' : 'bg-surface-2 text-ink-2'
        }`}
        data-merchant-avatar="fallback"
      >
        <CategoryIcon category={category} size={20} focusable="false" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[0.875rem] border ${TONE_CLASS[mark.tone]}`}
      data-merchant-avatar={mark.id}
    >
      {mark.glyph({})}
    </span>
  );
}
