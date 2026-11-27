import { PublicKey } from '@solana/web3.js';

/**
 * The deployed program on Solana devnet. If you deploy your own copy, paste
 * its address here (or set the NEXT_PUBLIC_PROGRAM_ID environment variable
 * on your host).
 */
export const PROGRAM_ID_STRING =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? '3k7jN3ufVfnp4w6UQDZkNmVimPKEU1pTcTXsxx3ABDHJ';

export const PROGRAM_ID = new PublicKey(PROGRAM_ID_STRING);

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://api.devnet.solana.com';

export const CLUSTER = 'devnet';

/** The devnet test dollar has six decimals, like USDC. */
export const DECIMALS = 6;

/** Protocol fee set at first-time setup: 10% of each discount. */
export const DEFAULT_FEE_BPS = 1000;

export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? '';

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;
}
