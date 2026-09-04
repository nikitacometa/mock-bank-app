import { useCallback, useEffect, useRef } from 'react';
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
  const onClickRef = useRef(onClick);
  const forwardNativeClick = useCallback(() => onClickRef.current(), []);

  useEffect(() => {
    onClickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!supported) return;
    show({ text, onClick: forwardNativeClick, disabled });
  }, [supported, show, text, disabled, forwardNativeClick]);

  useEffect(() => {
    if (!supported) return;
    return () => hide();
  }, [supported, hide]);

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
