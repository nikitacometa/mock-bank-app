/**
 * Contact chip: initials + deterministic hue from the name — offline, no
 * external avatar services (docs/spec.md §5.2).
 */
const HUES = [210, 165, 85, 25, 310, 255, 140, 350];

function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

export function Avatar({ name, initials, size = 48 }: { name: string; initials: string; size?: number }) {
  const hue = hueOf(name);
  return (
    <div
      aria-hidden
      className="flex items-center justify-center rounded-full font-medium select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `oklch(0.32 0.045 ${hue})`,
        color: `oklch(0.87 0.06 ${hue})`,
      }}
    >
      {initials}
    </div>
  );
}
