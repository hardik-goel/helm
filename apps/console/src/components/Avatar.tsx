'use client';

/**
 * Deterministic pixel avatar. Same name always yields the same face, so an
 * agent is recognisable across projects without anyone picking an icon.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const INKS = ['#E8A33D', '#5BC99A', '#8B7CD8', '#D8DBE4', '#E0554A'];

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const h = hash(name);
  const color = INKS[h % INKS.length]!;
  const cells: boolean[] = [];

  // 5 columns mirrored around the centre: 3 generated, 2 reflected.
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      cells.push(((h >> ((y * 3 + x) % 29)) & 1) === 1);
    }
  }
  const at = (x: number, y: number) => cells[y * 3 + (x < 3 ? x : 4 - x)]!;

  const px = size / 5;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${name} avatar`}
      style={{ flex: 'none', borderRadius: 3, background: '#0f1219' }}
    >
      {Array.from({ length: 5 }).flatMap((_, y) =>
        Array.from({ length: 5 }).map((_, x) =>
          at(x, y) ? (
            <rect
              key={`${x}-${y}`}
              x={x * px}
              y={y * px}
              width={px}
              height={px}
              fill={color}
              opacity={0.92}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
