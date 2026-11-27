'use client';

import { Keypair } from '@solana/web3.js';
import { useState } from 'react';
import { Addr, SetupNotice } from '@/components/Bits';
import { PROGRAM_ID_STRING, RPC_URL, explorerAddress } from '@/lib/config';
import { percent } from '@/lib/format';
import { fetchConfig } from '@/lib/program';
import { useLoad, useSession } from '@/lib/session';

/**
 * One-time tasks for whoever deployed the program. Nothing on this page is
 * needed to use the app.
 */
export default function SetupPage() {
  const session = useSession();
  const config = useLoad(() => fetchConfig(session.program), [session.version]);
  const [drip, setDrip] = useState<{ address: string; secret: string } | null>(null);

  const createDripWallet = () => {
    const keypair = Keypair.generate();
    setDrip({ address: keypair.publicKey.toBase58(), secret: JSON.stringify(Array.from(keypair.secretKey)) });
  };

  const copy = (text: string, what: string) =>
    void navigator.clipboard?.writeText(text).then(() => session.notify('info', `${what} copied`));

  return (
    <div className="stack-lg">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="title">Deployment setup</h1>
        <p className="muted">One-time tasks for whoever deployed the program. Nothing here is needed to use the app.</p>
      </div>

      <section className="sheet stack" aria-labelledby="program-title">
        <h2 className="heading" id="program-title">
          The program
        </h2>
        <dl className="facts">
          <dt>Address</dt>
          <dd>
            <Addr value={PROGRAM_ID_STRING} edge={10} />{' '}
            <a href={explorerAddress(PROGRAM_ID_STRING)} target="_blank" rel="noreferrer">
              open in the explorer
            </a>
          </dd>
          <dt>Network</dt>
          <dd>Solana devnet, through {RPC_URL}</dd>
          <dt>Status</dt>
          <dd>
            {config.loading
              ? 'Checking.'
              : config.error
                ? `Could not reach devnet. ${config.error}`
                : config.data
                  ? `Set up. The protocol keeps ${percent(config.data.feeBps)} of each discount.`
                  : 'Deployed address not set up yet.'}
          </dd>
          {config.data && (
            <>
              <dt>Fee collector</dt>
              <dd>
                <Addr value={config.data.treasury} edge={8} />
              </dd>
              <dt>Test dollar</dt>
              <dd>
                <Addr value={config.data.demoMint} edge={8} />
              </dd>
            </>
          )}
        </dl>
        {!config.loading && !config.error && config.data === null && (
          <>
            {!session.address && (
              <p className="muted">Start the demo or connect a wallet first; the wallet that sets it up becomes the fee collector.</p>
            )}
            <SetupNotice />
          </>
        )}
      </section>

      <section className="sheet stack" aria-labelledby="drip-title">
        <h2 className="heading" id="drip-title">
          Fee money for demo wallets
        </h2>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          New demo wallets need a little devnet SOL for network fees, and Solana&apos;s public devnet faucet no
          longer serves apps directly. So this deployment keeps its own small wallet for that: each demo
          session takes 0.03 SOL from it. Create one here, send it devnet SOL from{' '}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            faucet.solana.com
          </a>
          , then save its secret key as the environment variable <code>DRIP_SECRET_KEY</code> on your host and
          redeploy. Use it for devnet only.
        </p>
        {!drip ? (
          <button type="button" className="btn" onClick={createDripWallet}>
            Create a fee-money wallet
          </button>
        ) : (
          <dl className="facts">
            <dt>Send devnet SOL to</dt>
            <dd>
              <code>{drip.address}</code>{' '}
              <button type="button" className="linkish" onClick={() => copy(drip.address, 'Address')}>
                copy
              </button>
            </dd>
            <dt>DRIP_SECRET_KEY</dt>
            <dd>
              <button type="button" className="btn small" onClick={() => copy(drip.secret, 'Secret key')}>
                Copy the secret key
              </button>
              <p className="small muted" style={{ marginTop: 6 }}>
                Shown once and never stored by this page. Anyone holding it can spend that wallet&apos;s devnet SOL.
              </p>
            </dd>
          </dl>
        )}
      </section>
    </div>
  );
}
