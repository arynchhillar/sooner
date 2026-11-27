import { DECIMALS } from './config';

const UNIT = 10n ** BigInt(DECIMALS);

/** 985205480n -> "985.21". Rounds to the nearest cent; the chain keeps all six decimals. */
export function money(baseUnits: bigint, fractionDigits = 2): string {
  const negative = baseUnits < 0n;
  let value = negative ? -baseUnits : baseUnits;
  const dropped = BigInt(DECIMALS - fractionDigits);
  if (dropped > 0n) {
    const step = 10n ** dropped;
    value = (value + step / 2n) / step;
  }
  const scale = 10n ** BigInt(fractionDigits);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(fractionDigits, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fractionDigits > 0 ? '.' + fraction : ''}`;
}

/** 985205480n -> "985.20". Cut, not rounded: used where the figure sits beside the live amount. */
export function moneyDown(baseUnits: bigint): string {
  const cents = 10n ** BigInt(DECIMALS - 2);
  return money((baseUnits / cents) * cents);
}

/** Splits an exact amount for the live display: "985.20" and the fast-moving "5480". */
export function moneyParts(baseUnits: bigint): { main: string; fine: string } {
  const full = money(baseUnits, DECIMALS);
  return { main: full.slice(0, -4), fine: full.slice(-4) };
}

/** "1,250.50" -> 1250500000n. Returns null when the text is not a valid amount. */
export function parseMoney(text: string): bigint | null {
  const clean = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(DECIMALS, '0'));
}

export function shortKey(address: string, edge = 4): string {
  return address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function day(unixSeconds: number): string {
  return dateFormat.format(new Date(unixSeconds * 1000));
}

export function dayTime(unixSeconds: number): string {
  return dateTimeFormat.format(new Date(unixSeconds * 1000));
}

/** 3_888_000 -> "45 days", 5400 -> "1 hour 30 min", 42 -> "42 sec". */
export function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours >= 1) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes >= 1) return `${minutes} min`;
  return `${s} sec`;
}

/** Date input value (yyyy-mm-dd, local) for a date `days` from now. */
export function dateInputValue(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** End of the chosen local day, as unix seconds: paying on the due date is on time. */
export function endOfDayUnix(dateInput: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!match) return null;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
