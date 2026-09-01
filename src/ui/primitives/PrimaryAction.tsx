import { useEffect } from 'react';
import { usePlatform } from '@/platform/usePlatform';

/**
 * The single primary CTA of a flow, behind the platform seam
 * (docs/spec.md §5.3): web renders a DOM button; in TMA the same call-site
 * drives the native MainButton and renders nothing.
 */
export function PrimaryAction({
  text,
  onClick,
  disabled,
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const platform = usePlatform();
  const { supported, show, hide } = platform.mainButton;

  useEffect(() => {
    if (!supported) return;
    show({ text, onClick, disabled });
    return () => hide();
  }, [supported, show, hide, text, onClick, disabled]);

  if (supported) return null;
  return (
    <button
      className="w-full rounded-btn bg-ivory py-3.5 text-[1.0625rem] font-semibold text-bg transition-[background,transform] duration-150 active:scale-[0.985] active:bg-ivory-press disabled:opacity-35 disabled:active:scale-100"
      style={{ transitionTimingFunction: 'var(--ease-out-premium)' }}
      onClick={onClick}
      disabled={disabled}
    >
      {text}
    </button>
  );
}
