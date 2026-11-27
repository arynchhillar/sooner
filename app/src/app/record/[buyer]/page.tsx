'use client';

import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { useMemo } from 'react';
import { Addr, StatusTag } from '@/components/Bits';
import { day, money, percent } from '@/lib/format';
import { fetchConfig, fetchPayablesOfPool, fetchPool, poolPda } from '@/lib/program';
import { useLoad, useSession } from '@/lib/session';

function days(seconds: bigint, count: number): string {
  if (count === 0) return '0';
  return (Number(seconds) / 86_400 / count).toFixed(1).replace(/\.0$/, '');
}

export default function RecordPage({ params }: { params: { buyer: string } }) {
  const { program, version } = useSession();

  const buyer = useMemo(() => {
    try {
      return new PublicKey(params.buyer);
    } catch {
      return null;
    }
  }, [params.buyer]);

  const loaded = useLoad(
    async () => {
      if (!buyer) return null;
      const config = await fetchConfig(program);
      if (!config) return null;
      const pool = await fetchPool(program, poolPda(buyer, config.demoMint));
      if (!pool) return null;
      return { pool, payables: await fetchPayablesOfPool(program, pool.address) };
    },
    [params.buyer, version],
    30_000,
  );

  if (!buyer) return <p className="notice bad">That is not a valid Solana address.</p>;
  if (loaded.loading && !loaded.data) return <p className="muted">Loading the record from Solana.</p>;
  if (loaded.error) return <p className="notice bad">Could not reach Solana devnet. {loaded.error}</p>;
  if (!loaded.data) {
    return (
      <div className="notice stack">
        <p>This wallet has not opened a pool on Sooner, so it has no payment record here yet.</p>
        <Link href="/">Back to the start</Link>
      </div>
    );
  }

  const { pool, payables } = loaded.data;
  const paid = pool.countEarly + pool.countOnTime + pool.countLate;
  const notLate = pool.countEarly + pool.countOnTime;
  const share = paid === 0 ? null : Math.round((notLate / paid) * 100);

  return (
    <div className="stack-lg desk desk-record">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="title">How this buyer pays</h1>
        <p className="muted">
          The record of buyer <Addr value={pool.buyer} edge={6} />, built from every payment made through
          Sooner. Nobody can edit it, including the buyer.
        </p>
      </div>

      <dl className="figures">
        <div>
          <dt>Paid on time or early</dt>
          <dd className="num">{share === null ? 'No payments yet' : `${share}%`}</dd>
          <p className="small muted after">
            {notLate} of {paid} paid invoices
          </p>
        </div>
        <div>
          <dt>Taken early by suppliers</dt>
          <dd className="num">{pool.countEarly}</dd>
          <p className="small muted after">
            On average {days(pool.secondsEarly, pool.countEarly + pool.countOnTime)} days before the due date
          </p>
        </div>
        <div>
          <dt>Paid late</dt>
          <dd className="num" style={{ color: pool.countLate > 0 ? 'var(--red)' : undefined }}>
            {pool.countLate}
          </dd>
          <p className="small muted after">
            {pool.countLate === 0
              ? 'No late payments on record'
              : `On average ${days(pool.secondsLate, pool.countLate)} days after the due date`}
          </p>
        </div>
        <div>
          <dt>Paid to suppliers so far</dt>
          <dd className="num">{money(pool.totalPaid)}</dd>
          <p className="small muted after">
            {money(pool.outstanding)} approved and still open, at {percent(pool.rateBps)} a year
          </p>
        </div>
      </dl>

      <section className="stack" aria-labelledby="history-title">
        <h2 className="heading" id="history-title">
          Every invoice
        </h2>
        <div className="sheet flush">
          {payables.length === 0 ? (
            <p className="empty">This buyer has not approved an invoice yet.</p>
          ) : (
            <div className="ledger-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Supplier</th>
                    <th className="right">Amount</th>
                    <th>Due</th>
                    <th>Paid</th>
                    <th>Status</th>
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
                      <td>{p.status === 'open' || p.status === 'voided' ? '' : day(p.paidAt)}</td>
                      <td>
                        <StatusTag status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
