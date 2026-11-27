import { day, money, moneyDown } from '@/lib/format';
import { discountFor } from '@/lib/math';

type Props = {
  amount: bigint;
  rateBps: number;
  approvedAt: number;
  dueAt: number;
  /** Where the marker sits, in unix seconds. Null hides it. */
  at: number | null;
  /** Label for the marker. Defaults to "Today". */
  atLabel?: string;
  settled?: boolean;
};

/**
 * The price of time for one invoice. The slanted line is what the supplier
 * can take on each day; the shaded wedge above it is the discount, which
 * shrinks to nothing at the due date.
 */
export function Slope({ amount, rateBps, approvedAt, dueAt, at, atLabel = 'Today', settled }: Props) {
  const width = 600;
  const height = 132;
  const top = 10;
  const bottom = 112;
  const floor = height - 8;

  const tenor = Math.max(1, dueAt - approvedAt);
  const progress = at === null ? 0 : Math.min(1, Math.max(0, (at - approvedAt) / tenor));
  const x = progress * width;
  const y = bottom - (bottom - top) * progress;

  const atApproval = amount - discountFor(amount, rateBps, tenor);
  const atMarker = at === null ? null : amount - discountFor(amount, rateBps, dueAt - at);
  const side = progress < 0.16 ? ' left' : progress > 0.84 ? ' right' : '';
  const colour = settled ? 'var(--green)' : 'var(--blue)';

  return (
    <div className="slope">
      {atMarker !== null && (
        <div className={`pin${side}${settled ? ' done' : ''}`} style={{ left: `${progress * 100}%` }}>
          {atLabel}: {moneyDown(atMarker)}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`The payout rises in a straight line from ${money(atApproval)} at approval to ${money(amount)} on the due date.`}
      >
        <polygon className="slope-wedge" points={`0,${top} ${width},${top} 0,${bottom}`} fill="var(--sun-wash)" />
        <line x1={0} y1={top} x2={width} y2={top} stroke="var(--ink-3)" strokeDasharray="3 5" />
        <path
          className="slope-line"
          d={`M0,${bottom} L${width},${top}`}
          pathLength={1}
          fill="none"
          stroke="var(--sun)"
          strokeWidth={3}
          strokeLinecap="round"
        />
        <line x1={0} y1={floor} x2={width} y2={floor} stroke="var(--ink)" strokeWidth={1.5} />
        {at !== null && (
          <g className="slope-marker" style={{ transform: `translate(${x}px, ${y}px)` }}>
            <line x1={0} y1={0} x2={0} y2={floor - y} stroke={colour} strokeWidth={1.5} strokeDasharray="2 4" />
            {!settled && <circle className="slope-pulse" r={6.5} fill="none" stroke={colour} strokeWidth={2} />}
            <circle r={6.5} fill={colour} stroke="#fff" strokeWidth={2.5} />
          </g>
        )}
      </svg>
      <div className="ends">
        <div>
          <b className="num">{money(atApproval)}</b>
          at approval, {day(approvedAt)}
        </div>
        <div>
          <b className="num">{money(amount)}</b>
          in full on {day(dueAt)}
        </div>
      </div>
    </div>
  );
}
