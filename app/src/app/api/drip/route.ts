import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { RPC_URL } from '@/lib/config';

/**
 * Fee money for demo wallets. Solana closed the public RPC faucet on devnet
 * in 2026, so apps can no longer airdrop SOL to a new wallet themselves.
 * A deployment funds a throwaway devnet wallet, puts its secret key in the
 * DRIP_SECRET_KEY environment variable (a JSON array of numbers), and this
 * route sends each new demo wallet enough SOL for fees.
 * Without that variable the route answers 501 and the app shows the manual
 * faucet link instead. Devnet only: never point this at a wallet with value.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One demo session needs about 0.013 SOL of rent; 1 SOL here funds about 30 sessions.
const DRIP_LAMPORTS = 0.03 * LAMPORTS_PER_SOL;
const ENOUGH_LAMPORTS = 0.015 * LAMPORTS_PER_SOL;
const WINDOW_MS = 10 * 60 * 1000;
const lastDrip = new Map<string, number>();

export async function POST(request: Request) {
  const secret = process.env.DRIP_SECRET_KEY;
  if (!secret) {
    return Response.json({ error: 'No drip wallet is configured for this deployment.' }, { status: 501 });
  }

  let recipient: PublicKey;
  try {
    const body = (await request.json()) as { address?: string };
    recipient = new PublicKey(body.address ?? '');
  } catch {
    return Response.json({ error: 'Send a JSON body with a valid "address".' }, { status: 400 });
  }

  const caller = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const now = Date.now();
  for (const key of [caller, recipient.toBase58()]) {
    const previous = lastDrip.get(key);
    if (previous && now - previous < WINDOW_MS) {
      return Response.json({ error: 'This wallet was funded a moment ago. Try again later.' }, { status: 429 });
    }
  }

  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    if ((await connection.getBalance(recipient)) >= ENOUGH_LAMPORTS) {
      return Response.json({ error: 'This wallet already has enough SOL for fees.' }, { status: 409 });
    }
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: DRIP_LAMPORTS }),
    );
    transaction.sign(payer);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    lastDrip.set(caller, now);
    lastDrip.set(recipient.toBase58(), now);
    return Response.json({ signature });
  } catch {
    return Response.json({ error: 'The drip wallet could not send SOL right now.' }, { status: 502 });
  }
}
