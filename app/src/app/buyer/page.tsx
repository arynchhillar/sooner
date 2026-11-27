'use client';

import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Addr, NeedSigner, SetupNotice, StatusTag } from '@/components/Bits';
import { dateInputValue, day, endOfDayUnix, money, moneyDown, nowUnix, parseMoney, percent } from '@/lib/format';
import { discountFor, feeFor, payoutAt } from '@/lib/math';
import {
  approveIx,
  faucetIxs,
  fetchConfig,
  fetchPayablesOfPool,
  fetchPool,
  fundIx,
  invoiceIdFor,
  openPoolIx,
  payablePda,
  poolPda,
  setRateIx,
  settleIxs,
  tokenAccountOf,
  tokenBalance,
  withdrawIxs,
  type ConfigView,
  type PayableView,
  type PoolView,
} from '@/lib/program';
import { useLoad, useNow, useSession } from '@/lib/session';

function OpenPool({ config }: { config: ConfigView }) {
  const session = useSession();
  const [rate, setRate] = useState(12);
  const open = async () => {
    if (!session.address) return;
    const ix = await openPoolIx(session.program, session.address, config.demoMint, Math.round(rate * 100));
    await session.send('Pool opened', [ix]);
  };
  return (
    <section className="sheet stack" aria-labelledby="open-title">
      <h2 className="heading" id="open-title">
        Open your early-payment pool
      </h2>
      <p className="muted" style={{ maxWidth: '62ch' }}>
        The rate is what you earn, per year, on cash that pays a supplier early. At 12%, paying a 1,000 invoice
        45 days early costs the supplier 14.79 and you keep it. You can change the rate later; invoices already
        approved keep theirs.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ width: 200 }}>
          <label htmlFor="open-rate">Rate (% a year)</label>
          <input
            id="open-rate"
            className="num"
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={open}
          disabled={session.busy !== null || !(rate >= 0 && rate <= 50)}
        >
          Open pool
        </button>
      </div>
    </section>
  );
}

function PoolFigures({ pool, walletBalance }: { pool: PoolView; walletBalance: bigint }) {
  const session = useSession();
  const [cash, setCash] = useState('');
  const [rate, setRate] = useState('');
  const amount = parseMoney(cash);
  const newRate = rate === '' ? null : Number(rate);

  const add = async () => {
    if (!amount || !session.address) return;
    const ix = await fundIx(session.program, session.address, pool, amount);
    if (await session.send(`${money(amount)} added to the vault`, [ix])) setCash('');
  };
  const takeOut = async () => {
    if (!amount) return;
    const ixs = await withdrawIxs(session.program, pool, amount);
    if (await session.send(`${money(amount)} taken out of the vault`, ixs)) setCash('');
  };
  const changeRate = async () => {
    if (newRate === null) return;
    const ix = await setRateIx(session.program, pool, Math.round(newRate * 100));
    if (await session.send(`Rate set to ${newRate}% a year`, [ix])) setRate('');
  };

  const busy = session.busy !== null;
  return (
    <dl className="figures">
      <div>
        <dt>Cash in the vault</dt>
        <dd className="num">{money(pool.vaultBalance)}</dd>
        <div className="after stack" style={{ gap: 8 }}>
          <input
            type="text"
            inputMode="decimal"
            className="num"
            placeholder="Amount"
            aria-label="Amount to add or take out"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
          />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn small primary"
              onClick={add}
              disabled={busy || !amount || amount > walletBalance}
            >
              Add cash
            </button>
            <button
              type="button"
              className="btn small"
              onClick={takeOut}
              disabled={busy || !amount || amount > pool.vaultBalance}
            >
              Take out
            </button>
          </div>
        </div>
      </div>
      <div>
        <dt>Rate for new approvals</dt>
        <dd className="num">{percent(pool.rateBps)} a year</dd>
        <div className="after row" style={{ gap: 8 }}>
          <input
            type="number"
            className="num"
            min={0}
            max={50}
            step={0.5}
            placeholder="New rate"
            aria-label="New rate, percent a year"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            style={{ width: 110 }}
          />
          <button
            type="button"
            className="btn small"
            onClick={changeRate}
            disabled={busy || newRate === null || !(newRate >= 0 && newRate <= 50)}
          >
            Set rate
          </button>
        </div>
      </div>
      <div>
        <dt>Approved, not yet paid</dt>
        <dd className="num">{money(pool.outstanding)}</dd>
        <p className="small muted after">
          {pool.outstanding > pool.vaultBalance
            ? 'More than the vault holds. Suppliers can only take what is in the vault.'
            : 'The vault covers every open invoice.'}
        </p>
      </div>
      <div>
        <dt>Discounts you have kept</dt>
        <dd className="num">{money(pool.totalDiscount - pool.totalFees)}</dd>
        <p className="small muted after">
          After {money(pool.totalFees)} in protocol fees.{' '}
          <Link href={`/record/${pool.buyer.toBase58()}`}>See your public record</Link>
        </p>
      </div>
    </dl>
  );
}

function ApproveForm({ pool, config }: { pool: PoolView; config: ConfigView }) {
  const session = useSession();
  const [supplierText, setSupplierText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [due, setDue] = useState(() => dateInputValue(45));
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);

  const supplier = useMemo(() => {
    try {
      return new PublicKey(supplierText.trim());
    } catch {
      return null;
    }
  }, [supplierText]);
  const amount = parseMoney(amountText);
  const dueAt = endOfDayUnix(due);
  const cleanReference = reference.trim();
  const referenceTooLong = new TextEncoder().encode(cleanReference).length > 32;

  let problem: string | null = null;
  if (supplierText && !supplier) problem = 'That is not a valid Solana address.';
  else if (supplier && session.address && supplier.equals(session.address))
    problem = 'The supplier must be a different wallet from yours.';
  else if (amountText && (!amount || amount === 0n)) problem = 'Enter an amount such as 1,250.50.';
  else if (dueAt !== null && dueAt <= nowUnix()) problem = 'The due date must be in the future.';
  else if (dueAt !== null && dueAt - nowUnix() > 366 * 86_400) problem = 'The due date can be at most 366 days away.';
  else if (referenceTooLong) problem = 'Keep the invoice number under 32 characters.';

  const complete = supplier && amount && amount > 0n && dueAt && cleanReference && !problem;
  const discount = amount && dueAt ? discountFor(amount, pool.rateBps, dueAt - nowUnix()) : 0n;
  const fee = feeFor(discount, config.feeBps);

  const approve = async () => {
    if (!complete || !supplier || !amount || !dueAt) return;
    const invoiceId = await invoiceIdFor(cleanReference, file);
    const ix = approveIx(session.program, pool, supplier, amount, dueAt, cleanReference, invoiceId);
    const signature = await session.send(`Invoice ${cleanReference} approved`, [await ix]);
    if (signature) {
      setLastLink(`${window.location.origin}/p/${payablePda(pool.address, invoiceId).toBase58()}`);
      setAmountText('');
      setReference('');
      setFile(null);
    }
  };

  return (
    <section className="sheet stack" aria-labelledby="approve-title">
      <h2 className="heading" id="approve-title">
        Approve an invoice
      </h2>
      <div className="form-grid">
        <div className="field col-7">
          <label htmlFor="ap-supplier">Supplier&apos;s wallet address</label>
          <input
            id="ap-supplier"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="The wallet that will be paid"
            value={supplierText}
            onChange={(e) => setSupplierText(e.target.value)}
          />
          {session.mode === 'demo' && session.demo && (
            <span className="hint">
              <button
                type="button"
                className="linkish"
                onClick={() => setSupplierText(session.demo!.supplier.publicKey.toBase58())}
              >
                Use the demo supplier wallet
              </button>
            </span>
          )}
        </div>
        <div className="field col-5">
          <label htmlFor="ap-reference">Invoice number</label>
          <input
            id="ap-reference"
            type="text"
            placeholder="INV-1042"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div className="field col-4">
          <label htmlFor="ap-amount">Amount</label>
          <div className="with-unit">
            <input
              id="ap-amount"
              className="num"
              type="text"
              inputMode="decimal"
              placeholder="1,000.00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <span>test dollars</span>
          </div>
        </div>
        <div className="field col-3">
          <label htmlFor="ap-due">Due date</label>
          <input id="ap-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="field col-5">
          <label htmlFor="ap-file">Invoice file (optional)</label>
          <input
            id="ap-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </div>

      {problem && <p className="notice bad">{problem}</p>}
      {complete && amount && (
        <p className="muted">
          If the supplier takes it today they get <b className="num">{money(amount - discount)}</b>. The discount
          is <b className="num">{money(discount)}</b>, of which {money(fee)} is the protocol fee and the rest is
          yours. An attached file never leaves this browser; only its fingerprint goes on-chain.
        </p>
      )}
      <div className="row">
        <button type="button" className="btn primary" onClick={approve} disabled={!complete || session.busy !== null}>
          Approve invoice
        </button>
        {lastLink && (
          <span className="small">
            Approved. Send the supplier this link:{' '}
            <button
              type="button"
              className="linkish"
              onClick={() => void navigator.clipboard?.writeText(lastLink).then(() => session.notify('info', 'Link copied'))}
            >
              copy link
            </button>
          </span>
        )}
      </div>
    </section>
  );
}

function InvoiceRows({ pool, payables }: { pool: PoolView; payables: PayableView[] }) {
  const session = useSession();
  const now = useNow();

  const payInFull = async (payable: PayableView) => {
    const ixs = await settleIxs(session.program, pool, payable);
    await session.send(`Invoice ${payable.reference} paid in full`, ixs);
  };

  if (payables.length === 0) {
    return <p className="empty">No invoices yet. Approve one above and it appears here.</p>;
  }
  return (
    <div className="ledger-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Supplier</th>
            <th className="right">Amount</th>
            <th>Due</th>
            <th>Status</th>
            <th className="right">Payout</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {payables.map((p) => (
            <tr key={p.address.toBase58()}>
              <td>
                <Link href={`/p/${p.address.toBase58()}`}>{p.reference || 'Invoice'}</Link>
              </td>
              <td>
                <Addr value={p.supplier} />
              </td>
              <td className="num right">{money(p.amount)}</td>
              <td>{day(p.dueAt)}</td>
              <td>
                <StatusTag status={p.status} />
              </td>
              <td className="num right">
                {p.status === 'open'
                  ? now === null
                    ? ''
                    : `${moneyDown(payoutAt(p.amount, p.rateBps, p.dueAt, now))} if taken now`
                  : p.status === 'voided'
                    ? ''
                    : `${money(p.paidAmount)} paid`}
              </td>
              <td className="right">
                {p.status === 'open' && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={session.busy !== null}
                    onClick={() => payInFull(p)}
                  >
                    Pay in full
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BuyerPage() {
  const session = useSession();
  const { address, program, connection, version } = session;

  useEffect(() => {
    if (session.mode === 'demo') session.setRole('buyer');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.mode]);

  const key = address?.toBase58() ?? '';
  const config = useLoad(() => fetchConfig(program), [version]);
  const mint = config.data?.demoMint;
  const pool = useLoad(
    async () => (address && mint ? fetchPool(program, poolPda(address, mint)) : null),
    [key, mint?.toBase58(), version],
    20_000,
  );
  const poolKey = pool.data?.address.toBase58() ?? '';
  const payables = useLoad(
    async () => (pool.data ? fetchPayablesOfPool(program, pool.data.address) : []),
    [poolKey, version],
    20_000,
  );
  const wallet = useLoad(
    async () => (address && mint ? tokenBalance(connection, tokenAccountOf(address, mint)) : 0n),
    [key, mint?.toBase58(), version],
  );

  const getDollars = async () => {
    if (!address || !mint) return;
    await session.send('10,000 test dollars received', await faucetIxs(program, address, address, mint));
  };

  if (!session.ready) return null;
  if (!address) return <NeedSigner what="use the buyer desk" />;

  return (
    <div className="stack-lg">
      <div className="spread">
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="title">Buyer desk</h1>
          <p className="muted">Approve invoices, keep the vault funded, and earn the discount when suppliers take cash early.</p>
        </div>
        {config.data && (
          <div className="row">
            <span className="muted">
              This wallet holds <b className="num">{money(wallet.data ?? 0n)}</b> test dollars
            </span>
            <button type="button" className="btn small" onClick={getDollars} disabled={session.busy !== null}>
              Get 10,000 test dollars
            </button>
          </div>
        )}
      </div>

      {config.error && <p className="notice bad">Could not reach Solana devnet. {config.error}</p>}
      {!config.loading && !config.error && config.data === null && <SetupNotice />}

      {config.data && pool.data === null && !pool.loading && <OpenPool config={config.data} />}

      {config.data && pool.data && (
        <>
          <PoolFigures pool={pool.data} walletBalance={wallet.data ?? 0n} />
          <ApproveForm pool={pool.data} config={config.data} />
          <section className="stack" aria-labelledby="invoices-title">
            <h2 className="heading" id="invoices-title">
              Your invoices
            </h2>
            <div className="sheet flush">
              <InvoiceRows pool={pool.data} payables={payables.data ?? []} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
