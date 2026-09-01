import type { SVGProps } from 'react';

/**
 * Custom icon set — one stroke weight, one geometry language, drawn for this
 * product (docs/spec.md §5.4: no stock icon library out of the box).
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 24, ...props }: P) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props,
  } as const;
}

/** Brand mark: comet head + trail. */
export function CometMark({ size = 24, ...props }: P) {
  return (
    <svg {...base({ size, ...props })}>
      <circle cx="8.5" cy="15.5" r="3.25" fill="currentColor" stroke="none" />
      <path d="M12.5 11.5 20 4" strokeWidth="2" />
      <path d="M14.5 15 19 10.5" opacity="0.55" />
      <path d="M9 9.5 13.5 5" opacity="0.3" />
    </svg>
  );
}

export function IconHome(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 10.5 12 4l7.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-5h-4v5H6A1.5 1.5 0 0 1 4.5 19v-8.5Z" />
    </svg>
  );
}

export function IconHistory(props: P) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.2l2.8 1.8" />
    </svg>
  );
}

export function IconCards(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6.5" width="15" height="10" rx="2.5" />
      <path d="M7.5 20h11A2.5 2.5 0 0 0 21 17.5V10" />
      <path d="M3 10.5h15" />
    </svg>
  );
}

export function IconTransfer(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4 9h13l-3.5-3.5" />
      <path d="M20 15H7l3.5 3.5" />
    </svg>
  );
}

export function IconSettings(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4 7.5h9M17 7.5h3" />
      <circle cx="15" cy="7.5" r="2" />
      <path d="M4 16.5h3M11 16.5h9" />
      <circle cx="9" cy="16.5" r="2" />
    </svg>
  );
}

export function IconSearch(props: P) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m19.5 19.5-3.8-3.8" />
    </svg>
  );
}

export function IconClose(props: P) {
  return (
    <svg {...base(props)}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function IconCheck(props: P) {
  return (
    <svg {...base(props)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconCopy(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1" transform="translate(1 1)" />
    </svg>
  );
}

export function IconFreeze(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" />
    </svg>
  );
}

export function IconChevronDown(props: P) {
  return (
    <svg {...base(props)}>
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function IconArrowUp(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5" />
    </svg>
  );
}

export function IconArrowDown(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14m0 0 5.5-5.5M12 19l-5.5-5.5" />
    </svg>
  );
}

export function IconBackspace(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M8.5 5.5h9A2.5 2.5 0 0 1 20 8v8a2.5 2.5 0 0 1-2.5 2.5h-9L3 12l5.5-6.5Z" />
      <path d="m11 9.5 5 5m0-5-5 5" />
    </svg>
  );
}

/* ---- transaction category icons ---- */

export function IconGroceries(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h2l2.2 10.5A1.5 1.5 0 0 0 9.7 17.5h7.6a1.5 1.5 0 0 0 1.47-1.2L20.5 9H6.4" />
      <circle cx="10" cy="20.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="17" cy="20.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconTransport(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M5 15.5 6.3 8.7A2 2 0 0 1 8.26 7h7.48a2 2 0 0 1 1.96 1.7L19 15.5" />
      <rect x="4" y="13.5" width="16" height="4.5" rx="1.5" />
      <path d="M7.2 16h.01M16.8 16h.01" strokeWidth="2.4" />
    </svg>
  );
}

export function IconCoffee(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M5.5 9h10v6a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4V9Z" />
      <path d="M15.5 10.5h1.5a2.5 2.5 0 0 1 0 5H15" />
      <path d="M8.5 4.5c0 1 .8 1 .8 2M11.7 4.5c0 1 .8 1 .8 2" opacity="0.6" />
    </svg>
  );
}

export function IconFood(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4 13.5a8 8 0 0 1 16 0Z" />
      <path d="M3.5 17h17" />
      <path d="M12 5.5V4" />
    </svg>
  );
}

export function IconShopping(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M6 8h12l-1 11a1.8 1.8 0 0 1-1.8 1.5H8.8A1.8 1.8 0 0 1 7 19L6 8Z" />
      <path d="M9.2 10.5V6.8a2.8 2.8 0 0 1 5.6 0v3.7" />
    </svg>
  );
}

export function IconHealth(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

export function IconEntertainment(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4 8.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.2a2.3 2.3 0 0 0 0 4.6v1.2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.2a2.3 2.3 0 0 0 0-4.6V8.5Z" />
      <path d="M13.5 7v2M13.5 11v2M13.5 15v2" opacity="0.6" />
    </svg>
  );
}

export function IconHouse(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M5 11 12 5l7 6" />
      <path d="M6.5 9.8V19h11V9.8" />
      <path d="M10 19v-4.5h4V19" />
    </svg>
  );
}

export function IconSalary(props: P) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="2" />
      <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
      <path d="M3.5 12h17" opacity="0.5" />
    </svg>
  );
}

export function IconSubscription(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9" />
      <path d="M19.5 4.5V9H15" />
      <path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15" />
      <path d="M4.5 19.5V15H9" />
    </svg>
  );
}

export function IconInterest(props: P) {
  return (
    <svg {...base(props)}>
      <path d="M12 4c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6Z" />
      <path d="M18.5 15.5c.3 1.7 1 2.4 2.5 2.7-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.7Z" opacity="0.6" />
    </svg>
  );
}

export function IconDot(props: P) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

const CATEGORY_ICONS: Record<string, (props: P) => ReturnType<typeof IconDot>> = {
  groceries: IconGroceries,
  transport: IconTransport,
  coffee: IconCoffee,
  food: IconFood,
  shopping: IconShopping,
  health: IconHealth,
  entertainment: IconEntertainment,
  home: IconHouse,
  salary: IconSalary,
  subscriptions: IconSubscription,
  transfer: IconTransfer,
  interest: IconInterest,
};

export function CategoryIcon({ category, ...props }: P & { category?: string }) {
  const Icon = (category && CATEGORY_ICONS[category]) || IconDot;
  return <Icon {...props} />;
}
