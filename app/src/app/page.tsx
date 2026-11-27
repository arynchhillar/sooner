'use client';

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Addr } from '@/components/Bits';
import { Slope } from '@/components/Slope';
import { DEFAULT_FEE_BPS } from '@/lib/config';
import { MIN_FEE_BALANCE, requestDevnetSol } from '@/lib/demo';
import { money, parseMoney, percent } from '@/lib/format';
import { discountFor, feeFor } from '@/lib/math';
import { faucetIxs, fetchConfig, initializeIx, tokenAccountOf, tokenBalance } from '@/lib/program';
import { useNow, useSession } from '@/lib/session';

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
          style={{ width: '100%', accentColor: 'var(--blue)' }}
        />
      </div>

      <div className="quote-lines">
        <div className="hero-line">
          <span>The supplier takes</span>
          <span className="num">{money(amount - discount)}</span>
        </div>
        <div>
          <span>
            The buyer earns as a discount, for paying {tenorDays - day} {tenorDays - day === 1 ? 'day' : 'days'}{' '}
            early
          </span>
          <span className="num">{money(discount)}</span>
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
          <button type="button" className="btn primary big" onClick={run} disabled={running}>
            Start the demo
          </button>
          <span className="muted small">No wallet or sign-up needed. Test money on Solana devnet.</span>
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

export default function HomePage() {
  const session = useSession();
  const signedIn = session.ready && session.address !== null;

  return (
    <div className="stack-lg">
      <div className="home">
        <div className="stack">
          <h1 className="display">Get paid before the due date.</h1>
          <p className="lede">
            A buyer approves your invoice on Solana and funds a vault. From that second you can take the money.
            The earlier you take it, the bigger the discount the buyer keeps. Wait for the due date and you get
            all of it.
          </p>
          <div style={{ paddingTop: 8 }}>
            {session.mode === 'wallet' && signedIn ? (
              <div className="row">
                <Link className="btn primary big" href="/buyer">
                  Open the buyer desk
                </Link>
                <Link className="btn big" href="/supplier">
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

      <section aria-labelledby="how-title" className="stack">
        <h2 className="title" id="how-title">
          How one invoice moves
        </h2>
        <ol className="steps">
          <li>
            <b>The buyer opens a pool</b>
            <span className="muted">
              Cash goes into a vault that only the program can pay from. The buyer sets a yearly rate.
            </span>
          </li>
          <li>
            <b>The buyer approves an invoice</b>
            <span className="muted">
              Supplier, amount and due date go on-chain. The rate is locked for that invoice.
            </span>
          </li>
          <li>
            <b>The supplier takes the money</b>
            <span className="muted">
              Any second before the due date, at that second&apos;s price. One transaction, paid from the vault.
            </span>
          </li>
          <li>
            <b>Anyone can check the record</b>
            <span className="muted">
              Every payment adds to the buyer&apos;s public record: early, on time or late.
            </span>
          </li>
        </ol>
      </section>

      <section className="sheet">
        <RecordLookup />
      </section>
    </div>
  );
}
