// The same arithmetic as the on-chain program (programs/sooner/src/lib.rs),
// in BigInt so the app's quote matches the chain to the last base unit.

export const SECONDS_PER_YEAR = 31_536_000n;
export const BPS = 10_000n;

/** Discount for paying `amount` when `secondsEarly` seconds remain. Rounded down. */
export function discountFor(amount: bigint, rateBps: number, secondsEarly: number): bigint {
  if (secondsEarly <= 0 || amount <= 0n) return 0n;
  const discount = (amount * BigInt(rateBps) * BigInt(Math.floor(secondsEarly))) / (BPS * SECONDS_PER_YEAR);
  return discount > amount ? amount : discount;
}

/** The protocol's share of a discount. */
export function feeFor(discount: bigint, feeBps: number): bigint {
  return (discount * BigInt(feeBps)) / BPS;
}

/** What the supplier receives if they collect at `now` (unix seconds). */
export function payoutAt(amount: bigint, rateBps: number, dueAt: number, now: number): bigint {
  return amount - discountFor(amount, rateBps, dueAt - now);
}
