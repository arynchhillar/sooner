'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Addr, LiveAmount, NeedSigner, StatusTag } from '@/components/Bits';
import { day, money, moneyDown, percent, span } from '@/lib/format';
import { discountFor, feeFor, payoutAt } from '@/lib/math';
import {
  claimIxs,
  fetchConfig,
  fetchPayablesOfSupplier,
  fetchPools,
  type ConfigView,
  type PayableView,
  type PoolView,
} from '@/lib/program';
import { useLoad, useNow, useSession } from '@/lib/session';

function OpenInvoice({
  payable,
  pool,
  config,
  now,
}: {
  payable: PayableView;
  pool: PoolView | undefined;
  config: ConfigView;
  now: number | null;
}) {
  const session = useSession();
  const payout = now === null ? null : payoutAt(payable.amount, payable.rateBps, payable.dueAt, now);
  const discount = now === null ? 0n : discountFor(payable.amount, payable.rateBps, payable.dueAt - now);
  const needed = payout === null ? 0n : payout + feeFor(discount, config.feeBps);
  const short = pool !== undefined && payout !== null && pool.vaultBalance < needed;
  const early = now !== null && now < payable.dueAt;

  const take = async () => {
    if (!pool) return;
    const ixs = await claimIxs(session.program, config, pool, payable);
    await session.send(`Invoice ${payable.reference} paid to your wallet`, ixs);
  };

  return (
    <div className="invoice">
      <div>
        <div className="row" style={{ gap: 10 }}>
          <Link className="heading" href={`/p/${payable.address.toBase58()}`}>
            {payable.reference || 'Invoice'}
          </Link>
          <span className="muted">
            {money(payable.amount)} due {day(payable.dueAt)}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <LiveAmount value={payout} compact />
        </div>
        <div className="meta">
          {early && now !== null ? (
            <span>
              {span(payable.dueAt - now)} early costs you {money(discount)} at {percent(payable.rateBps)} a year
            </span>
          ) : (
            <span>The due date has passed, so this is payable in full.</span>
          )}
          {pool && (
            <span>
              From buyer <Addr value={pool.buyer} />
            </span>
          )}
        </div>
        {short && pool && (
          <p className="notice small" style={{ marginTop: 12 }}>
            The buyer&apos;s vault holds {money(pool.vaultBalance)} right now, which is less than this payout. Ask
            them to add cash; the invoice stays approved.
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn primary big"
        onClick={take}
        disabled={session.busy !== null || payout === null || !pool || short}
      >
        {payout === null ? 'Take it now' : `Take ${moneyDown(payout)} now`}
      </button>
    </div>
  );
}

export default function SupplierPage() {
  const session = useSession();
  const { address, program, version } = session;
  const now = useNow();

  useEffect(() => {
    if (session.mode === 'demo') session.setRole('supplier');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.mode]);

  const key = address?.toBase58() ?? '';
  const config = useLoad(() => fetchConfig(program), [version]);
  const data = useLoad(
    async () => {
      if (!address) return { payables: [] as PayableView[], pools: new Map<string, PoolView>() };
      const payables = await fetchPayablesOfSupplier(program, address);
      const unique = new Map(payables.map((p) => [p.pool.toBase58(), p.pool]));
      const pools = await fetchPools(program, Array.from(unique.values()));
      return { payables, pools };
    },
    [key, version],
    15_000,
  );

  if (!session.ready) return null;
  if (!address) return <NeedSigner what="see invoices addressed to you" />;

  const payables = data.data?.payables ?? [];
  const pools = data.data?.pools ?? new Map<string, PoolView>();
  const open = payables.filter((p) => p.status === 'open');
  const closed = payables.filter((p) => p.status !== 'open');

  return (
    <div className="stack-lg">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="title">Supplier desk</h1>
        <p className="muted">
          Invoices a buyer has approved to this wallet. Take the money whenever you like; the amount grows every
          second until the due date.
        </p>
      </div>

      {data.error && <p className="notice bad">Could not reach Solana devnet. {data.error}</p>}

      <section className="stack" aria-labelledby="open-title">
        <h2 className="heading" id="open-title">
          Ready to take
        </h2>
        <div className="sheet flush">
          {open.length === 0 && (
            <div className="empty stack">
              <p>
                {data.loading
                  ? 'Looking for your invoices.'
                  : 'No open invoices are addressed to this wallet. Give your buyer this address so they can approve one to it:'}
              </p>
              {!data.loading && <Addr value={address} edge={10} />}
            </div>
          )}
          {config.data &&
            open.map((p) => (
              <OpenInvoice
                key={p.address.toBase58()}
                payable={p}
                pool={pools.get(p.pool.toBase58())}
                config={config.data!}
                now={now}
              />
            ))}
        </div>
      </section>

      {closed.length > 0 && (
        <section className="stack" aria-labelledby="closed-title">
          <h2 className="heading" id="closed-title">
            Already settled
          </h2>
          <div className="sheet flush">
            <div className="ledger-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th className="right">Amount</th>
                    <th className="right">You received</th>
                    <th>Paid on</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((p) => (
                    <tr key={p.address.toBase58()}>
                      <td>
                        <Link href={`/p/${p.address.toBase58()}`}>{p.reference || 'Invoice'}</Link>
                      </td>
                      <td className="num right">{money(p.amount)}</td>
                      <td className="num right">{p.status === 'voided' ? '' : money(p.paidAmount)}</td>
                      <td>{day(p.paidAt)}</td>
                      <td>
                        <StatusTag status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
