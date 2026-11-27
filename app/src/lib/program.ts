import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import idl from '@/idl/sooner.json';
import { PROGRAM_ID } from './config';

// ------------------------------------------------------------------ client

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error('This client only builds instructions and reads accounts.');
  },
  signAllTransactions: async () => {
    throw new Error('This client only builds instructions and reads accounts.');
  },
};

/** An Anchor client used to read accounts and build instructions. Signing happens in the session. */
export function getProgram(connection: Connection): Program {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET as any, { commitment: 'confirmed' });
  return new Program(idl as unknown as Idl, PROGRAM_ID, provider);
}

export const ERROR_MESSAGES: Record<number, string> = Object.fromEntries(
  (idl.errors as { code: number; msg: string }[]).map((e) => [e.code, e.msg]),
);

// --------------------------------------------------------------- addresses

const seed = (text: string) => Buffer.from(text);

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([seed('config')], PROGRAM_ID)[0];
}

export function demoMintPda(): PublicKey {
  return PublicKey.findProgramAddressSync([seed('demo_mint')], PROGRAM_ID)[0];
}

export function poolPda(buyer: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed('pool'), buyer.toBuffer(), mint.toBuffer()], PROGRAM_ID)[0];
}

export function vaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed('vault'), pool.toBuffer()], PROGRAM_ID)[0];
}

export function payablePda(pool: PublicKey, invoiceId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed('payable'), pool.toBuffer(), Buffer.from(invoiceId)],
    PROGRAM_ID,
  )[0];
}

export function tokenAccountOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

// ------------------------------------------------------------------- views

export type Status = 'open' | 'paidEarly' | 'paidOnTime' | 'paidLate' | 'voided';

export const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  paidEarly: 'Paid early',
  paidOnTime: 'Paid on time',
  paidLate: 'Paid late',
  voided: 'Voided',
};

export type ConfigView = {
  admin: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  demoMint: PublicKey;
};

export type PoolView = {
  address: PublicKey;
  buyer: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  rateBps: number;
  createdAt: number;
  outstanding: bigint;
  totalApproved: bigint;
  totalPaid: bigint;
  totalDiscount: bigint;
  totalFees: bigint;
  countApproved: number;
  countEarly: number;
  countOnTime: number;
  countLate: number;
  countVoided: number;
  secondsEarly: bigint;
  secondsLate: bigint;
  vaultBalance: bigint;
};

export type PayableView = {
  address: PublicKey;
  pool: PublicKey;
  supplier: PublicKey;
  amount: bigint;
  rateBps: number;
  approvedAt: number;
  dueAt: number;
  status: Status;
  paidAt: number;
  paidAmount: bigint;
  discount: bigint;
  invoiceId: Uint8Array;
  reference: string;
};

const big = (value: BN): bigint => BigInt(value.toString());

/* eslint-disable @typescript-eslint/no-explicit-any */
function toPool(address: PublicKey, raw: any, vaultBalance: bigint): PoolView {
  return {
    address,
    buyer: raw.buyer,
    mint: raw.mint,
    vault: raw.vault,
    rateBps: raw.rateBps,
    createdAt: raw.createdAt.toNumber(),
    outstanding: big(raw.outstanding),
    totalApproved: big(raw.totalApproved),
    totalPaid: big(raw.totalPaid),
    totalDiscount: big(raw.totalDiscount),
    totalFees: big(raw.totalFees),
    countApproved: raw.countApproved,
    countEarly: raw.countEarly,
    countOnTime: raw.countOnTime,
    countLate: raw.countLate,
    countVoided: raw.countVoided,
    secondsEarly: big(raw.secondsEarly),
    secondsLate: big(raw.secondsLate),
    vaultBalance,
  };
}

function toPayable(address: PublicKey, raw: any): PayableView {
  const bytes = Uint8Array.from(raw.reference as number[]);
  const end = bytes.indexOf(0);
  return {
    address,
    pool: raw.pool,
    supplier: raw.supplier,
    amount: big(raw.amount),
    rateBps: raw.rateBps,
    approvedAt: raw.approvedAt.toNumber(),
    dueAt: raw.dueAt.toNumber(),
    status: Object.keys(raw.status)[0] as Status,
    paidAt: raw.paidAt.toNumber(),
    paidAmount: big(raw.paidAmount),
    discount: big(raw.discount),
    invoiceId: Uint8Array.from(raw.invoiceId as number[]),
    reference: new TextDecoder().decode(end === -1 ? bytes : bytes.slice(0, end)),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------- reads

export async function fetchConfig(program: Program): Promise<ConfigView | null> {
  const raw = await program.account.config.fetchNullable(configPda());
  if (!raw) return null;
  return {
    admin: raw.admin as PublicKey,
    treasury: raw.treasury as PublicKey,
    feeBps: raw.feeBps as number,
    demoMint: raw.demoMint as PublicKey,
  };
}

export async function tokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(tokenAccount);
  if (!info || info.data.length < AccountLayout.span) return 0n;
  return AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount;
}

export async function fetchPool(program: Program, address: PublicKey): Promise<PoolView | null> {
  const raw = await program.account.pool.fetchNullable(address);
  if (!raw) return null;
  const balance = await tokenBalance(program.provider.connection, raw.vault as PublicKey);
  return toPool(address, raw, balance);
}

export async function fetchPools(program: Program, addresses: PublicKey[]): Promise<Map<string, PoolView>> {
  const out = new Map<string, PoolView>();
  if (addresses.length === 0) return out;
  const raws = await program.account.pool.fetchMultiple(addresses);
  const found = raws
    .map((raw, i) => ({ raw, address: addresses[i] }))
    .filter((entry) => entry.raw !== null);
  const vaults = await program.provider.connection.getMultipleAccountsInfo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    found.map((entry) => (entry.raw as any).vault as PublicKey),
  );
  found.forEach((entry, i) => {
    const info = vaults[i];
    const balance =
      info && info.data.length >= AccountLayout.span
        ? AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount
        : 0n;
    out.set(entry.address.toBase58(), toPool(entry.address, entry.raw, balance));
  });
  return out;
}

export type Totals = {
  pools: number;
  approved: number;
  early: number;
  paid: bigint;
  /** Discounts buyers kept, after the protocol fee. */
  kept: bigint;
};

/** Layout of a Pool account: 8-byte tag, then buyer (32), then mint (32). */
const POOL_MINT_OFFSET = 40;

/**
 * Adds up every pool that uses one mint, for the live figures on the home
 * page. Amounts in different mints cannot be added together, so the caller
 * picks the mint (the devnet test dollar).
 */
export async function fetchTotals(program: Program, mint: PublicKey): Promise<Totals> {
  const rows = await program.account.pool.all([{ memcmp: { offset: POOL_MINT_OFFSET, bytes: mint.toBase58() } }]);
  const totals: Totals = { pools: rows.length, approved: 0, early: 0, paid: 0n, kept: 0n };
  for (const row of rows) {
    const pool = toPool(row.publicKey, row.account, 0n);
    totals.approved += pool.countApproved;
    totals.early += pool.countEarly;
    totals.paid += pool.totalPaid;
    totals.kept += pool.totalDiscount - pool.totalFees;
  }
  return totals;
}

export async function fetchPayable(program: Program, address: PublicKey): Promise<PayableView | null> {
  const raw = await program.account.payable.fetchNullable(address);
  return raw ? toPayable(address, raw) : null;
}

/** Layout of a Payable account: 8-byte tag, then pool (32), then supplier (32). */
const PAYABLE_POOL_OFFSET = 8;
const PAYABLE_SUPPLIER_OFFSET = 40;

async function payablesWhere(program: Program, offset: number, key: PublicKey): Promise<PayableView[]> {
  const rows = await program.account.payable.all([{ memcmp: { offset, bytes: key.toBase58() } }]);
  return rows
    .map((row) => toPayable(row.publicKey, row.account))
    .sort((a, b) => b.approvedAt - a.approvedAt);
}

export const fetchPayablesOfPool = (program: Program, pool: PublicKey) =>
  payablesWhere(program, PAYABLE_POOL_OFFSET, pool);

export const fetchPayablesOfSupplier = (program: Program, supplier: PublicKey) =>
  payablesWhere(program, PAYABLE_SUPPLIER_OFFSET, supplier);

// ------------------------------------------------------------ instructions

const u64 = (value: bigint) => new BN(value.toString());

function ensureTokenAccount(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(payer, tokenAccountOf(owner, mint), owner, mint);
}

/** First-time setup of a fresh deployment: protocol fee and the test dollar mint. */
export function initializeIx(program: Program, admin: PublicKey, feeBps: number) {
  return program.methods
    .initialize(feeBps)
    .accounts({
      admin,
      config: configPda(),
      demoMint: demoMintPda(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Mints 10,000 test dollars to `recipient` (devnet only). */
export async function faucetIxs(program: Program, payer: PublicKey, recipient: PublicKey, mint: PublicKey) {
  return [
    ensureTokenAccount(payer, recipient, mint),
    await program.methods
      .demoFaucet()
      .accounts({
        payer,
        config: configPda(),
        demoMint: mint,
        recipientToken: tokenAccountOf(recipient, mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export function openPoolIx(program: Program, buyer: PublicKey, mint: PublicKey, rateBps: number) {
  const pool = poolPda(buyer, mint);
  return program.methods
    .openPool(rateBps)
    .accounts({
      buyer,
      mint,
      pool,
      vault: vaultPda(pool),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function setRateIx(program: Program, pool: PoolView, rateBps: number) {
  return program.methods.setRate(rateBps).accounts({ buyer: pool.buyer, pool: pool.address }).instruction();
}

export function fundIx(program: Program, funder: PublicKey, pool: PoolView, amount: bigint) {
  return program.methods
    .fund(u64(amount))
    .accounts({
      funder,
      pool: pool.address,
      mint: pool.mint,
      vault: pool.vault,
      funderToken: tokenAccountOf(funder, pool.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function withdrawIxs(program: Program, pool: PoolView, amount: bigint) {
  return [
    ensureTokenAccount(pool.buyer, pool.buyer, pool.mint),
    await program.methods
      .withdraw(u64(amount))
      .accounts({
        buyer: pool.buyer,
        pool: pool.address,
        mint: pool.mint,
        vault: pool.vault,
        destination: tokenAccountOf(pool.buyer, pool.mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export function referenceBytes(reference: string): number[] {
  const bytes = new TextEncoder().encode(reference).slice(0, 32);
  const out = new Array<number>(32).fill(0);
  bytes.forEach((b, i) => (out[i] = b));
  return out;
}

/** The invoice id is the SHA-256 of the invoice file, or of its number when no file is given. */
export async function invoiceIdFor(reference: string, file?: File | null): Promise<Uint8Array> {
  const data = file
    ? new Uint8Array(await file.arrayBuffer())
    : new TextEncoder().encode(`invoice:${reference.trim().toUpperCase()}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function approveIx(
  program: Program,
  pool: PoolView,
  supplier: PublicKey,
  amount: bigint,
  dueAt: number,
  reference: string,
  invoiceId: Uint8Array,
) {
  return program.methods
    .approvePayable(Array.from(invoiceId), u64(amount), new BN(dueAt), referenceBytes(reference))
    .accounts({
      buyer: pool.buyer,
      pool: pool.address,
      supplier,
      payable: payablePda(pool.address, invoiceId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** The supplier collects. Creates the token accounts involved if they do not exist yet. */
export async function claimIxs(program: Program, config: ConfigView, pool: PoolView, payable: PayableView) {
  const supplier = payable.supplier;
  return [
    ensureTokenAccount(supplier, supplier, pool.mint),
    ensureTokenAccount(supplier, config.treasury, pool.mint),
    await program.methods
      .claim()
      .accounts({
        supplier,
        config: configPda(),
        pool: pool.address,
        payable: payable.address,
        mint: pool.mint,
        vault: pool.vault,
        supplierToken: tokenAccountOf(supplier, pool.mint),
        treasuryToken: tokenAccountOf(config.treasury, pool.mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

/** The buyer pays in full, topping the vault up first if it is short. */
export async function settleIxs(program: Program, pool: PoolView, payable: PayableView) {
  const ixs = [ensureTokenAccount(pool.buyer, payable.supplier, pool.mint)];
  if (pool.vaultBalance < payable.amount) {
    ixs.push(await fundIx(program, pool.buyer, pool, payable.amount - pool.vaultBalance));
  }
  ixs.push(
    await program.methods
      .settle()
      .accounts({
        buyer: pool.buyer,
        pool: pool.address,
        payable: payable.address,
        mint: pool.mint,
        vault: pool.vault,
        supplierToken: tokenAccountOf(payable.supplier, pool.mint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );
  return ixs;
}

export function voidIx(program: Program, payable: PayableView) {
  return program.methods
    .voidPayable()
    .accounts({ supplier: payable.supplier, pool: payable.pool, payable: payable.address })
    .instruction();
}
