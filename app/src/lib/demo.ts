import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

/**
 * Demo wallets: two throwaway devnet keypairs kept in this browser's storage,
 * so one person can play the buyer and the supplier without installing a
 * wallet. They hold test tokens only and must never be used on mainnet.
 */
export type DemoRole = 'buyer' | 'supplier';

const storageKey = (role: DemoRole) => `sooner-demo-${role}`;

export function loadDemoKeypair(role: DemoRole, create: boolean): Keypair | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(storageKey(role));
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored) as number[]));
    } catch {
      window.localStorage.removeItem(storageKey(role));
    }
  }
  if (!create) return null;
  const keypair = Keypair.generate();
  window.localStorage.setItem(storageKey(role), JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

/**
 * A whole demo (pool, vault, a few invoices, the supplier's token account)
 * costs about 0.013 SOL in account rent plus a few thousandths in fees.
 */
export const MIN_FEE_BALANCE = 0.015 * LAMPORTS_PER_SOL;

/**
 * Gets devnet SOL for network fees. Solana's public RPC faucet was closed in
 * 2026, so the first stop is this deployment's own drip endpoint
 * (see /setup). The RPC airdrop is kept as a second try for clusters that
 * still serve it, such as a local validator. Returns false when neither
 * works, so the caller can show the manual faucet link.
 */
export async function requestDevnetSol(connection: Connection, to: PublicKey): Promise<boolean> {
  try {
    const response = await fetch('/api/drip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: to.toBase58() }),
    });
    if (response.ok) {
      const { signature } = (await response.json()) as { signature: string };
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      return true;
    }
  } catch {
    // No drip endpoint configured, or it is out of SOL.
  }
  try {
    const signature = await connection.requestAirdrop(to, LAMPORTS_PER_SOL / 10);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    return true;
  } catch {
    // Closed on public devnet.
  }
  return false;
}
