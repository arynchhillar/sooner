'use client';

import type { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { useState } from 'react';
import { DEFAULT_FEE_BPS, PROGRAM_ID_STRING, REPO_URL, explorerAddress, explorerTx } from '@/lib/config';
import { money, moneyParts, percent, shortKey } from '@/lib/format';
import { STATUS_LABEL, initializeIx, type Status } from '@/lib/program';
import { useSession } from '@/lib/session';

/** A short address that copies the full one when pressed. */
export function Addr({ value, edge = 4 }: { value: PublicKey | string; edge?: number }) {
  const full = typeof value === 'string' ? value : value.toBase58();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="addr"
      title={`${full} (press to copy)`}
      onClick={() => {
        void navigator.clipboard?.writeText(full).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? 'Copied' : shortKey(full, edge)}
    </button>
  );
}

export function StatusTag({ status }: { status: Status }) {
  return (
    <span className={`status ${status}`}>
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** The amount a supplier can take right now, with the fast-moving digits set smaller. */
export function LiveAmount({ value, compact }: { value: bigint | null; compact?: boolean }) {
  if (value === null) {
    return (
      <div className={`live${compact ? ' compact' : ''}`} aria-hidden>
        &nbsp;
      </div>
    );
  }
  const { main, fine } = moneyParts(value);
  return (
    <div className={`live${compact ? ' compact' : ''}`} aria-label={`${money(value)} test dollars`}>
      <span aria-hidden>
        {main}
        <span className="fine">{fine}</span>
      </span>
      {!compact && (
        <span className="unit" aria-hidden>
          test dollars
        </span>
      )}
    </div>
  );
}

/** Shown when nobody is signed in on a page that needs a signer. */
export function NeedSigner({ what }: { what: string }) {
  const session = useSession();
  return (
    <div className="sheet stack">
      <h2 className="heading">Pick a wallet to {what}</h2>
      <p className="muted">
        The demo wallet needs nothing installed: it creates two test wallets in this browser, one for the buyer
        and one for the supplier. Or use your own Solana wallet set to devnet.
      </p>
      <div className="row">
        <Link className="btn primary" href="/" onClick={() => session.enterDemo()}>
          Start the demo
        </Link>
        <span className="muted">or use Connect wallet at the top of the page.</span>
      </div>
    </div>
  );
}

/** A fresh deployment has no settings yet. Whoever sets it up becomes the fee collector. */
export function SetupNotice() {
  const session = useSession();
  const setUp = async () => {
    if (!session.address) return;
    const ix = await initializeIx(session.program, session.address, DEFAULT_FEE_BPS);
    await session.send('Set up this deployment', [ix]);
  };
  return (
    <div className="notice stack">
      <p>
        <b>This deployment has not been set up yet.</b> Setting it up creates the test dollar and fixes the
        protocol fee at {percent(DEFAULT_FEE_BPS)} of each discount. It takes one transaction.
      </p>
      <button className="btn" type="button" disabled={!session.address || session.busy !== null} onClick={setUp}>
        Set up this deployment
      </button>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useSession();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <div>
            {toast.text}
            {toast.signature && (
              <>
                {' '}
                <a href={explorerTx(toast.signature)} target="_blank" rel="noreferrer">
                  See it on the explorer
                </a>
              </>
            )}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function Foot() {
  return (
    <footer className="foot">
      <div className="wrap">
        <span>Sooner runs on Solana devnet with test money only.</span>
        <a href={explorerAddress(PROGRAM_ID_STRING)} target="_blank" rel="noreferrer">
          Program {shortKey(PROGRAM_ID_STRING, 6)}
        </a>
        <a href="/setup">Deployment setup</a>
        {REPO_URL && (
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source code
          </a>
        )}
      </div>
    </footer>
  );
}
