'use client';

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type CSSProperties } from 'react';
import { Addr } from '@/components/Bits';
import { HeroField, Reveal } from '@/components/Motion';
import { Slope } from '@/components/Slope';
import { DEFAULT_FEE_BPS, PROGRAM_ID_STRING, explorerAddress } from '@/lib/config';
import { MIN_FEE_BALANCE, requestDevnetSol } from '@/lib/demo';
import { money, parseMoney, percent, shortKey } from '@/lib/format';
import { discountFor, feeFor } from '@/lib/math';
import { faucetIxs, fetchConfig, fetchTotals, initializeIx, tokenAccountOf, tokenBalance } from '@/lib/program';
import { useLoad, useNow, useSession } from '@/lib/session';

type StepState = 'todo' | 'doing' | 'done' | 'failed';
const STEP_LABELS = [
  'Create a buyer wallet and a supplier wallet in this browser',
  'Get devnet SOL to pay network fees',
  'Give the supplier wallet fee money',
  'Get 10,000 test dollars for the buyer',
];

/** A working quote: change the invoice and drag the day to see what waiting is worth. */
function Quote() {
  const now = useNow();
  const [amountText, setAmountText] = useState('1,000');
  const [days, setDays] = useState(45);
  const [ratePercent, setRatePercent] = useState(12);
  const [takeDay, setTakeDay] = useState(0);

  const amount = parseMoney(amountText) ?? 0n;
  const rateBps = Math.round(Math.min(50, Math.max(0, ratePercent || 0)) * 100);
  const tenorDays = Math.min(366, Math.max(1, Math.round(days || 1)));
  const day = Math.min(takeDay, tenorDays);
  const discount = discountFor(amount, rateBps, (tenorDays - day) * 86_400);
  const fee = feeFor(discount, DEFAULT_FEE_BPS);
  const start = now ?? 0;
  // 0 on the day of approval, 1 on the due date. The payout figure fills out
  // as the supplier waits and the discount figure thins away.
  const waited = day / tenorDays;

  return (
    <section className="instrument" aria-labelledby="quote-title">
      <h2 className="heading" id="quote-title">
        What is waiting worth?
      </h2>
      <div className="form-grid" style={{ marginTop: 18 }}>
        <div className="field col-5">
          <label htmlFor="q-amount">Invoice amount</label>
          <input
            id="q-amount"
            className="num"
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
          />
        </div>
        <div className="field col-3">
          <label htmlFor="q-days">Due in (days)</label>
          <input
            id="q-days"
            className="num"
            type="number"
            min={1}
            max={366}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </div>
        <div className="field col-4">
          <label htmlFor="q-rate">Buyer&apos;s rate (% a year)</label>
          <input
            id="q-rate"
            className="num"
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={ratePercent}
            onChange={(e) => setRatePercent(Number(e.target.value))}
          />
        </div>
      </div>

      <div style={{ marginTop: 26, minHeight: 96 }}>
        {now !== null && (
          <Slope
            amount={amount}
            rateBps={rateBps}
            approvedAt={start}
            dueAt={start + tenorDays * 86_400}
            at={start + day * 86_400}
            atLabel={day === 0 ? 'Today' : `Day ${day}`}
          />
        )}
      </div>

      <div className="field" style={{ marginTop: 18 }}>
        <label htmlFor="q-day">Take the money on day {day} of {tenorDays}</label>
        <input
          id="q-day"
          type="range"
          min={0}
          max={tenorDays}
          value={day}
          onChange={(e) => setTakeDay(Number(e.target.value))}
          className="day"
          style={{ '--p': `${waited * 100}%` } as CSSProperties}
        />
      </div>

      <div className="quote-lines">
        <div className="hero-line">
          <span>The supplier takes</span>
          <span
            className="num morph"
            style={{
              fontStretch: `${Math.round(74 + waited * 46)}%`,
              fontWeight: Math.round(600 + waited * 180),
              color: waited >= 1 ? 'var(--green)' : undefined,
            }}
          >
            {money(amount - discount)}
          </span>
        </div>
        <div>
          <span>
            The buyer earns as a discount, for paying {tenorDays - day} {tenorDays - day === 1 ? 'day' : 'days'}{' '}
            early
          </span>
          <span
            className="num morph discount"
            style={{ fontStretch: `${Math.round(104 - waited * 42)}%`, fontWeight: Math.round(680 - waited * 240) }}
          >
            {money(discount)}
          </span>
        </div>
        <div>
          <span className="muted">Protocol fee, taken out of that discount ({percent(DEFAULT_FEE_BPS)})</span>
          <span className="num muted">{money(fee)}</span>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        The same arithmetic runs inside the Solana program, per second, at the moment the supplier takes the
        money.
      </p>
    </section>
  );
}

function DemoStarter() {
  const session = useSession();
  const [steps, setSteps] = useState<StepState[]>(['todo', 'todo', 'todo', 'todo']);
  const [running, setRunning] = useState(false);
  const [needSol, setNeedSol] = useState<PublicKey | null>(null);
  const allDone = steps.every((s) => s === 'done');

  const mark = (index: number, state: StepState) =>
    setSteps((list) => list.map((s, i) => (i === index ? state : s)));

  const run = async () => {
    setRunning(true);
    setNeedSol(null);
    let at = 0;
    try {
      const { connection, program } = session;
      mark(0, 'doing');
      const pair = session.enterDemo();
      session.setRole('buyer');
      const buyer = pair.buyer.publicKey;
      const supplier = pair.supplier.publicKey;
      mark(0, 'done');

      at = 1;
      mark(1, 'doing');
      if ((await connection.getBalance(buyer)) < MIN_FEE_BALANCE) {
        const funded = await requestDevnetSol(connection, buyer);
        if (!funded) {
          mark(1, 'failed');
          setNeedSol(buyer);
          return;
        }
      }
      mark(1, 'done');

      at = 2;
      mark(2, 'doing');
      if ((await connection.getBalance(supplier)) < 0.004 * LAMPORTS_PER_SOL) {
        const transfer = SystemProgram.transfer({
          fromPubkey: buyer,
          toPubkey: supplier,
          lamports: 0.006 * LAMPORTS_PER_SOL,
        });
        if (!(await session.send('Fee money sent to the supplier wallet', [transfer], pair.buyer))) {
          mark(2, 'failed');
          return;
        }
      }
      mark(2, 'done');

      at = 3;
      mark(3, 'doing');
      let config = await fetchConfig(program);
      if (!config) {
        const setUp = await initializeIx(program, buyer, DEFAULT_FEE_BPS);
        if (!(await session.send('Deployment set up', [setUp], pair.buyer))) {
          mark(3, 'failed');
          return;
        }
        config = await fetchConfig(program);
      }
      if (!config) {
        mark(3, 'failed');
        return;
      }
      const held = await tokenBalance(connection, tokenAccountOf(buyer, config.demoMint));
      if (held < 1_000_000_000n) {
        const ixs = await faucetIxs(program, buyer, buyer, config.demoMint);
        if (!(await session.send('10,000 test dollars received', ixs, pair.buyer))) {
          mark(3, 'failed');
          return;
        }
      }
      mark(3, 'done');
    } catch (error) {
      mark(at, 'failed');
      session.notify('error', error instanceof Error ? error.message : 'The demo could not start.');
    } finally {
      setRunning(false);
    }
  };

  const started = steps.some((s) => s !== 'todo');

  return (
    <div className="stack">
      {!started && (
        <div className="row">
          <button type="button" className="btn primary big cta" onClick={run} disabled={running}>
            Start the demo
          </button>
          <span className="small hero-note">No wallet or sign-up needed. Test money on Solana devnet.</span>
        </div>
      )}
      {started && (
        <div className="sheet stack">
          <ul className="checklist">
            {STEP_LABELS.map((label, i) => (
              <li key={label} className={steps[i]}>
                {label}
              </li>
            ))}
          </ul>
          {needSol && (
            <div className="notice stack">
              <p>
                This deployment&apos;s fee wallet could not fund the buyer wallet, so it has no SOL for network
                fees yet. Copy this address, get free devnet SOL for it at{' '}
                <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                  faucet.solana.com
                </a>{' '}
                (the smallest amount is plenty), then continue. You can also connect your own devnet wallet
                instead.
              </p>
              <div className="row">
                <Addr value={needSol} edge={8} />
                <button type="button" className="btn" onClick={run} disabled={running}>
                  Continue
                </button>
              </div>
            </div>
          )}
          {!needSol && !allDone && !running && (
            <button type="button" className="btn" onClick={run}>
              Try again
            </button>
          )}
          {allDone && (
            <div className="row">
              <Link className="btn primary" href="/buyer">
                Open the buyer desk
              </Link>
              <span className="muted small">
                Next: open a pool, approve an invoice, then switch to the supplier and take it.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecordLookup() {
  const router = useRouter();
  const [text, setText] = useState('');
  const valid = useMemo(() => {
    try {
      return new PublicKey(text.trim()).toBase58();
    } catch {
      return null;
    }
  }, [text]);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) router.push(`/record/${valid}`);
      }}
    >
      <div className="field" style={{ flex: '1 1 320px' }}>
        <label htmlFor="lookup">Check how a buyer pays</label>
        <input
          id="lookup"
          type="text"
          placeholder="Buyer wallet address"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button type="submit" className="btn" disabled={!valid} style={{ alignSelf: 'flex-end' }}>
        Open payment record
      </button>
    </form>
  );
}

/** What this deployment has done so far, read from the program's own accounts. */
function LiveNumbers() {
  const { program, version } = useSession();
  const totals = useLoad(
    async () => {
      const config = await fetchConfig(program);
      return config ? fetchTotals(program, config.demoMint) : null;
    },
    [version],
    30_000,
  );
  const data = totals.data;
  // Stay quiet while loading or if devnet cannot be reached: the rest of the page does not depend on this.
  if (!data) return null;

  return (
    <section aria-labelledby="live-title" className="stack live-numbers">
      <Reveal as="h2" className="title" id="live-title">
        <span className="live-dot" aria-hidden /> Live on Solana devnet
      </Reveal>
      {data.approved === 0 ? (
        <p className="notice info">
          Nothing has been approved on this deployment yet. Start the demo at the top of the page to make the
          first invoice.
        </p>
      ) : (
        <dl className="figures">
          <div>
            <dt>Invoices approved</dt>
            <dd className="num">{data.approved}</dd>
            <p className="small muted after">
              across {data.pools} buyer {data.pools === 1 ? 'pool' : 'pools'}
            </p>
          </div>
          <div>
            <dt>Taken early by suppliers</dt>
            <dd className="num">{data.early}</dd>
            <p className="small muted after">before their due date</p>
          </div>
          <div>
            <dt>Paid to suppliers</dt>
            <dd className="num">{money(data.paid)}</dd>
            <p className="small muted after">test dollars, straight from buyers&apos; vaults</p>
          </div>
          <div>
            <dt>Discounts kept by buyers</dt>
            <dd className="num">{money(data.kept)}</dd>
            <p className="small muted after">after the protocol fee</p>
          </div>
        </dl>
      )}
      <p className="small muted">
        These figures are read from the accounts of program{' '}
        <a href={explorerAddress(PROGRAM_ID_STRING)} target="_blank" rel="noreferrer">
          {shortKey(PROGRAM_ID_STRING, 6)}
        </a>{' '}
        and refresh every 30 seconds.
      </p>
    </section>
  );
}

const COMPARISON = [
  ['Who pays early', 'Outside lenders', 'The buyer who owes the money'],
  ['Is the invoice real?', 'Needs an oracle or manual checks', 'The buyer approves its own invoice'],
  ['If the buyer never pays', 'The lenders take the loss', 'Nobody lent anything'],
  ['What the buyer gets', 'Nothing', 'A return on idle cash'],
  ['Needed to get started', 'A funded lending pool', "Only the buyer's own cash"],
];

const REASONS = [
  {
    colour: 'var(--blue)',
    title: 'Settled in about a second',
    text: 'For a fraction of a cent. That is what makes a discount on a 200 dollar invoice worth taking, at 2 a.m. on a Sunday if need be.',
  },
  {
    colour: 'var(--sun)',
    title: 'One transaction does everything',
    text: 'It prices the time, pays the supplier, pays the fee and updates the record together. Nobody holds the money in between.',
  },
  {
    colour: 'var(--green)',
    title: 'Vaults only the program can open',
    text: "The buyer commits cash up front, so the supplier needs nobody's sign-off at the moment they take it.",
  },
  {
    colour: 'var(--violet)',
    title: 'A public record for free',
    text: 'Every payment already sits on a public ledger, so how a buyer pays becomes something anyone can check.',
  },
];

const QUESTIONS = [
  {
    q: 'Is this a loan?',
    a: 'No. Nobody lends anything. The buyer pays its own invoice early, and the discount is the price of those days.',
  },
  {
    q: 'What if the vault does not hold enough?',
    a: 'The invoice stays approved, and the supplier can take the money as soon as the buyer adds cash. Both sides see the shortfall on the invoice page.',
  },
  {
    q: 'What happens after the due date?',
    a: "The discount has shrunk to zero by then, so the supplier takes the full amount. A payment made after the due date goes on the buyer's public record as late.",
  },
  {
    q: 'How does Sooner earn money?',
    a: 'It keeps 10% of each discount, taken in the same transaction that pays the supplier. If nobody takes money early, it earns nothing.',
  },
  {
    q: 'Is the money real?',
    a: 'Not yet. This runs on Solana devnet with test dollars, and the program has not been audited.',
  },
];

/** The running example used across the page: 1,000.00 due in 45 days at 12% a year. */
const EXAMPLE_AMOUNT = 1_000_000_000n;
const EXAMPLE_DISCOUNT = discountFor(EXAMPLE_AMOUNT, 1200, 45 * 86_400);
const EXAMPLE_FEE = feeFor(EXAMPLE_DISCOUNT, DEFAULT_FEE_BPS);

const lineDelay = (index: number) => ({ '--i': index }) as CSSProperties;
const stepStyle = (index: number, colour: string) => ({ '--i': index, '--c': colour }) as CSSProperties;

export default function HomePage() {
  const session = useSession();
  const signedIn = session.ready && session.address !== null;

  return (
    <div className="stack-lg">
      <section className="hero" aria-labelledby="hero-title">
        <HeroField />
        <div className="home">
          <div className="stack hero-copy">
            <h1 className="display kinetic" id="hero-title">
              <span className="k-line" style={lineDelay(0)}>
                Get paid
              </span>{' '}
              <span className="k-line breathe" style={lineDelay(1)}>
                before the
              </span>{' '}
              <span className="k-line mark" style={lineDelay(2)}>
                due date.
              </span>
            </h1>
            <p className="lede">
              A buyer approves your invoice on Solana and funds a vault. From that second you can take the
              money. The earlier you take it, the bigger the discount the buyer keeps. Wait for the due date and
              you get all of it.
            </p>
            <div className="hero-cta">
              {session.mode === 'wallet' && signedIn ? (
                <div className="row">
                  <Link className="btn primary big cta" href="/buyer">
                    Open the buyer desk
                  </Link>
                  <Link className="btn big cta-ghost" href="/supplier">
                    Open the supplier desk
                  </Link>
                </div>
              ) : (
                <DemoStarter />
              )}
            </div>
          </div>
          <Quote />
        </div>
      </section>

      <section aria-labelledby="how-title" className="stack">
        <Reveal as="h2" className="title" id="how-title">
          How one invoice moves
        </Reveal>
        <Reveal as="ol" className="steps">
          <li style={stepStyle(0, 'var(--blue)')}>
            <b>The buyer opens a pool</b>
            <span className="muted">
              Cash goes into a vault that only the program can pay from. The buyer sets a yearly rate.
            </span>
          </li>
          <li style={stepStyle(1, 'var(--sun)')}>
            <b>The buyer approves an invoice</b>
            <span className="muted">
              Supplier, amount and due date go on-chain. The rate is locked for that invoice.
            </span>
          </li>
          <li style={stepStyle(2, 'var(--green)')}>
            <b>The supplier takes the money</b>
            <span className="muted">
              Any second before the due date, at that second&apos;s price. One transaction, paid from the vault.
            </span>
          </li>
          <li style={stepStyle(3, 'var(--violet)')}>
            <b>Anyone can check the record</b>
            <span className="muted">
              Every payment adds to the buyer&apos;s public record: early, on time or late.
            </span>
          </li>
        </Reveal>
      </section>

      <section aria-labelledby="sides-title" className="stack">
        <Reveal as="h2" className="title" id="sides-title">
          What each side gets
        </Reveal>
        <div className="sides">
          <Reveal as="article" className="side supplier" index={0}>
            <h3 className="heading">Suppliers: cash on the day you choose</h3>
            <p className="big num">{money(EXAMPLE_AMOUNT - EXAMPLE_DISCOUNT)}</p>
            <p className="small">today, on a 1,000.00 invoice that is due in 45 days</p>
            <p>
              No lender and no application. The price is on screen before you press, and it only improves as the
              due date gets closer.
            </p>
            <Link className="btn" href="/supplier">
              Open the supplier desk
            </Link>
          </Reveal>
          <Reveal as="article" className="side buyer" index={1}>
            <h3 className="heading">Buyers: a return on money that was sitting still</h3>
            <p className="big num">{money(EXAMPLE_DISCOUNT - EXAMPLE_FEE)}</p>
            <p className="small">kept on that same invoice for paying 45 days early, after the protocol fee</p>
            <p>
              You approve invoices you already owe and set the yearly rate. If the supplier waits, you pay the
              full amount on the due date as usual.
            </p>
            <Link className="btn" href="/buyer">
              Open the buyer desk
            </Link>
          </Reveal>
        </div>
      </section>

      <section aria-labelledby="differs-title" className="stack">
        <Reveal as="h2" className="title" id="differs-title">
          How it differs from invoice factoring
        </Reveal>
        <p className="lede wide">
          Most invoice projects on-chain are factoring: outside lenders buy the invoice. Sooner is funded by the
          buyer, and that removes the three hard problems of factoring.
        </p>
        <Reveal className="compare-wrap">
          <table className="compare">
            <thead>
              <tr>
                <td />
                <th scope="col">Invoice factoring on-chain</th>
                <th scope="col" className="us">
                  Sooner
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map(([topic, them, us], index) => (
                <tr key={topic} style={lineDelay(index)}>
                  <th scope="row">{topic}</th>
                  <td data-label="Factoring">{them}</td>
                  <td data-label="Sooner" className="us">
                    {us}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
        <p className="muted">
          It is not a loan. It is the buyer settling its own debt early, at a price both sides can see.
        </p>
      </section>

      <section aria-labelledby="solana-title" className="stack">
        <Reveal as="h2" className="title" id="solana-title">
          Why it runs on Solana
        </Reveal>
        <div className="reasons">
          {REASONS.map((reason, index) => (
            <Reveal as="article" className="reason" index={index} colour={reason.colour} key={reason.title}>
              <span className="reason-mark" aria-hidden />
              <h3 className="heading">{reason.title}</h3>
              <p className="muted">{reason.text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <LiveNumbers />

      <Reveal as="section" className="sheet lookup">
        <RecordLookup />
      </Reveal>

      <section aria-labelledby="questions-title" className="stack">
        <Reveal as="h2" className="title" id="questions-title">
          Questions people ask
        </Reveal>
        <div className="questions">
          {QUESTIONS.map((item) => (
            <details className="qa" key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
