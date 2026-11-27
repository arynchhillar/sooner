'use client';

import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { useMemo } from 'react';
import { Addr, LiveAmount, StatusTag } from '@/components/Bits';
import { Slope } from '@/components/Slope';
import { explorerAddress } from '@/lib/config';
import { day, dayTime, money, moneyDown, percent, span } from '@/lib/format';
import { discountFor, feeFor, payoutAt } from '@/lib/math';
import { claimIxs, fetchConfig, fetchPayable, fetchPool, settleIxs, voidIx } from '@/lib/program';
import { useLoad, useNow, useSession } from '@/lib/session';

export default function PayablePage({ params }: { params: { address: string } }) {
  const session = useSession();
  const { program, version, address: me } = session;
  const now = useNow();

  const payableKey = useMemo(() => {
    try {
      return new PublicKey(params.address);
    } catch {
      return null;
    }
  }, [params.address]);

  const loaded = useLoad(
    async () => {
      if (!payableKey) return null;
      const payable = await fetchPayable(program, payableKey);
      if (!payable) return null;
      const [pool, config] = await Promise.all([fetchPool(program, payable.pool), fetchConfig(program)]);
      return pool && config ? { payable, pool, config } : null;
    },
    [params.address, version],
    10_000,
  );

  if (!payableKey) return <p className="notice bad">That link does not contain a valid invoice address.</p>;
  if (loaded.loading && !loaded.data) return <p className="muted">Loading the invoice from Solana.</p>;
  if (loaded.error) return <p className="notice bad">Could not reach Solana devnet. {loaded.error}</p>;
  if (!loaded.data) {
    return (
      <div className="notice stack">
        <p>No invoice lives at this address on devnet. Check the link with whoever sent it.</p>
        <Link href="/">Back to the start</Link>
      </div>
    );
  }

  const { payable, pool, config } = loaded.data;
  const isOpen = payable.status === 'open';
  const iAmSupplier = me !== null && me.equals(payable.supplier);
  const iAmBuyer = me !== null && me.equals(pool.buyer);

  const payout = now === null ? null : payoutAt(payable.amount, payable.rateBps, payable.dueAt, now);
  const discount = now === null ? 0n : discountFor(payable.amount, payable.rateBps, payable.dueAt - now);
  const fee = feeFor(discount, config.feeBps);
  const short = payout !== null && pool.vaultBalance < payout + fee;
  const early = now !== null && now < payable.dueAt;
  const paidEarlyBy = payable.dueAt - payable.paidAt;

  const take = async () => {
    await session.send(
      `Invoice ${payable.reference} paid to your wallet`,
      await claimIxs(program, config, pool, payable),
    );
  };
  const payInFull = async () => {
    await session.send(`Invoice ${payable.reference} paid in full`, await settleIxs(program, pool, payable));
  };
  const release = async () => {
    if (!window.confirm('Release the buyer from this invoice? You will not be able to take payment for it here.')) {
      return;
    }
    await session.send(`Invoice ${payable.reference} released`, [await voidIx(program, payable)]);
  };

  return (
    <div className="stack-lg">
      <div className="spread">
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="title">Invoice {payable.reference}</h1>
          <p className="muted">
            {money(payable.amount)} test dollars, due {day(payable.dueAt)}
          </p>
        </div>
        <StatusTag status={payable.status} />
      </div>

      <div className="two">
        <section className="instrument stack" aria-label="What this invoice pays">
          {isOpen ? (
            <>
              <p className="muted">{early ? 'The supplier can take, this second' : 'Payable in full'}</p>
              <LiveAmount value={payout} />
              <Slope
                amount={payable.amount}
                rateBps={payable.rateBps}
                approvedAt={payable.approvedAt}
                dueAt={payable.dueAt}
                at={now}
              />
              {early && now !== null && (
                <p className="muted">
                  Taking it {span(payable.dueAt - now)} early costs {money(discount)}. Of that, {money(fee)} is
                  the protocol fee and the rest goes to the buyer. The exact amount is fixed on-chain at the
                  second the supplier takes it.
                </p>
              )}
            </>
          ) : payable.status === 'voided' ? (
            <>
              <p className="muted">Released by the supplier on {dayTime(payable.paidAt)}</p>
              <LiveAmount value={0n} />
              <p className="muted">Nothing was paid for this invoice through Sooner.</p>
            </>
          ) : (
            <>
              <p className="muted">Paid to the supplier on {dayTime(payable.paidAt)}</p>
              <LiveAmount value={payable.paidAmount} />
              <Slope
                amount={payable.amount}
                rateBps={payable.rateBps}
                approvedAt={payable.approvedAt}
                dueAt={payable.dueAt}
                at={payable.paidAt}
                atLabel="Paid"
                settled
              />
              <p className="muted">
                {payable.status === 'paidEarly'
                  ? `Taken ${span(paidEarlyBy)} before the due date, at a discount of ${money(payable.discount)}.`
                  : payable.status === 'paidOnTime'
                    ? 'Paid in full on or before the due date.'
                    : `Paid in full ${span(-paidEarlyBy)} after the due date.`}
              </p>
            </>
          )}

          {isOpen && iAmSupplier && (
            <div className="stack">
              {short && (
                <p className="notice">
                  The buyer&apos;s vault holds {money(pool.vaultBalance)} right now, less than this payout. Ask
                  them to add cash; the invoice stays approved.
                </p>
              )}
              <div className="row">
                <button
                  type="button"
                  className="btn primary big"
                  onClick={take}
                  disabled={session.busy !== null || payout === null || short}
                >
                  {payout === null ? 'Take it now' : `Take ${moneyDown(payout)} now`}
                </button>
                <button type="button" className="btn danger" onClick={release} disabled={session.busy !== null}>
                  Release invoice
                </button>
              </div>
            </div>
          )}
          {isOpen && iAmBuyer && (
            <div className="row">
              <button type="button" className="btn primary" onClick={payInFull} disabled={session.busy !== null}>
                Pay {money(payable.amount)} in full now
              </button>
              <span className="muted small">Paid from your vault, topped up from your wallet if it is short.</span>
            </div>
          )}
          {isOpen && !iAmSupplier && !iAmBuyer && (
            <p className="notice info">
              Only the supplier&apos;s wallet can take this payment.{' '}
              {session.mode === 'demo'
                ? 'Switch the demo wallet at the top of the page to act as the supplier or the buyer.'
                : 'Connect the wallet this invoice was approved to.'}
            </p>
          )}
        </section>

        <section className="sheet stack" aria-label="Invoice details">
          <h2 className="heading">Details</h2>
          <dl className="facts">
            <dt>Buyer</dt>
            <dd>
              <Addr value={pool.buyer} /> <Link href={`/record/${pool.buyer.toBase58()}`}>payment record</Link>
            </dd>
            <dt>Supplier</dt>
            <dd>
              <Addr value={payable.supplier} />
            </dd>
            <dt>Amount</dt>
            <dd className="num">{money(payable.amount)}</dd>
            <dt>Rate</dt>
            <dd>{percent(payable.rateBps)} a year, locked at approval</dd>
            <dt>Approved</dt>
            <dd>{dayTime(payable.approvedAt)}</dd>
            <dt>Due</dt>
            <dd>{dayTime(payable.dueAt)}</dd>
            <dt>In the vault</dt>
            <dd className="num">{money(pool.vaultBalance)}</dd>
            <dt>On-chain</dt>
            <dd>
              <a href={explorerAddress(payable.address.toBase58())} target="_blank" rel="noreferrer">
                View this invoice account
              </a>
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
