import type { SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { Transaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature, StandardDisconnectFeature } from '@wallet-standard/features';

/**
 * Browser wallets, through the Wallet Standard that Phantom, Solflare,
 * Backpack and the rest all implement. No adapter library is needed.
 */
export type SolanaWallet = Wallet & {
  features: StandardConnectFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature>;
};

const CHAIN = 'solana:devnet';

function isSolanaWallet(wallet: Wallet): wallet is SolanaWallet {
  return (
    'standard:connect' in wallet.features &&
    'solana:signTransaction' in wallet.features &&
    wallet.chains.some((chain) => chain.startsWith('solana:'))
  );
}

export function listWallets(): SolanaWallet[] {
  return getWallets().get().filter(isSolanaWallet);
}

/** Calls `onChange` whenever a wallet extension registers or goes away. */
export function watchWallets(onChange: () => void): () => void {
  const registry = getWallets();
  const offRegister = registry.on('register', onChange);
  const offUnregister = registry.on('unregister', onChange);
  return () => {
    offRegister();
    offUnregister();
  };
}

/** Asks the wallet for an account. With `silent`, only succeeds if the site was approved before. */
export async function connectWallet(wallet: SolanaWallet, silent = false): Promise<WalletAccount | null> {
  const { accounts } = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined);
  return accounts.find((account) => account.chains.some((chain) => chain.startsWith('solana:'))) ?? accounts[0] ?? null;
}

export async function disconnectWallet(wallet: SolanaWallet): Promise<void> {
  await wallet.features['standard:disconnect']?.disconnect();
}

export async function signWithWallet(
  wallet: SolanaWallet,
  account: WalletAccount,
  transaction: Transaction,
): Promise<Transaction> {
  const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const [output] = await wallet.features['solana:signTransaction'].signTransaction({
    account,
    transaction: unsigned,
    chain: CHAIN,
  });
  return Transaction.from(output.signedTransaction);
}
