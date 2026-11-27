'use client';

import type { Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RPC_URL } from './config';
import { loadDemoKeypair, type DemoRole } from './demo';
import { ERROR_MESSAGES, getProgram } from './program';
import {
  connectWallet,
  disconnectWallet,
  listWallets,
  signWithWallet,
  watchWallets,
  type SolanaWallet,
} from './wallets';

export type Mode = 'none' | 'demo' | 'wallet';

export type Toast = {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
  signature?: string;
};

type Session = {
  connection: Connection;
  program: Program;
  /** True once the browser-only state (storage, wallets) has been read. */
  ready: boolean;
  mode: Mode;
  role: DemoRole;
  setRole: (role: DemoRole) => void;
  /** The address that signs right now, if any. */
  address: PublicKey | null;
  demo: { buyer: Keypair; supplier: Keypair } | null;
  enterDemo: () => { buyer: Keypair; supplier: Keypair };
  /** Browser wallets found on this page. */
  wallets: SolanaWallet[];
  /** The connected browser wallet, if the session uses one. */
  wallet: SolanaWallet | null;
  connect: (wallet: SolanaWallet) => Promise<void>;
  leave: () => void;
  /** Signs, sends and confirms. Shows the outcome as a toast. Returns the signature, or null on failure. */
  send: (label: string, instructions: TransactionInstruction[], as?: Keypair) => Promise<string | null>;
  busy: string | null;
  /** Bumped after every confirmed transaction; data hooks reload on it. */
  version: number;
  refresh: () => void;
  toasts: Toast[];
  notify: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}

/** Turns a failed transaction into a sentence a person can act on. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs: string[] = (error as any)?.logs ?? [];
  const text = [message, ...logs].join('\n');

  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    const code = parseInt(custom[1], 16);
    if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    if (code === 0) return 'This already exists. An invoice number can only be approved once.';
    if (code === 1) return 'This wallet does not hold enough test dollars for that.';
    if (code === 2001) return 'This wallet is not allowed to do that for this invoice.';
    return `The program refused the transaction (code ${code}).`;
  }
  if (/no record of a prior credit|insufficient lamports|insufficient funds for (rent|fee)/i.test(text)) {
    return 'This wallet has no devnet SOL to pay the network fee.';
  }
  if (/user rejected|rejected the request/i.test(text)) return 'You cancelled the request in your wallet.';
  if (/blockhash not found|block height exceeded|expired/i.test(text)) {
    return 'The network took too long to confirm. Try again.';
  }
  if (/429|too many requests/i.test(text)) {
    return 'The public devnet endpoint is busy. Wait a few seconds and try again.';
  }
  return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const connection = useMemo(() => new Connection(RPC_URL, 'confirmed'), []);
  const program = useMemo(() => getProgram(connection), [connection]);

  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('none');
  const [role, setRoleState] = useState<DemoRole>('buyer');
  const [demo, setDemo] = useState<{ buyer: Keypair; supplier: Keypair } | null>(null);
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [wallet, setWallet] = useState<SolanaWallet | null>(null);
  const [walletKey, setWalletKey] = useState<{ key: PublicKey; account: Parameters<typeof signWithWallet>[1] } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  // Restore the last session from this browser.
  useEffect(() => {
    const storedMode = window.localStorage.getItem('sooner-mode') as Mode | null;
    const storedRole = window.localStorage.getItem('sooner-role') as DemoRole | null;
    const buyer = loadDemoKeypair('buyer', false);
    const supplier = loadDemoKeypair('supplier', false);
    if (buyer && supplier) setDemo({ buyer, supplier });
    if (storedRole === 'buyer' || storedRole === 'supplier') setRoleState(storedRole);
    if (storedMode === 'demo' && buyer && supplier) setMode('demo');
    setReady(true);

    // Keep the list of browser wallets current, and quietly reconnect the one used last time.
    const sync = () => setWallets(listWallets());
    sync();
    const stop = watchWallets(sync);
    let cancelled = false;
    if (storedMode === 'wallet') {
      const lastName = window.localStorage.getItem('sooner-wallet');
      const reconnect = async () => {
        const found = listWallets().find((w) => w.name === lastName);
        if (!found) return;
        try {
          const account = await connectWallet(found, true);
          if (!account || cancelled) return;
          setWallet(found);
          setWalletKey({ key: new PublicKey(account.address), account });
          setMode('wallet');
        } catch {
          // The site is no longer approved in the wallet; the person can connect again.
        }
      };
      // Extensions register a moment after the page loads.
      window.setTimeout(() => void reconnect(), 400);
    }
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const persistMode = useCallback((next: Mode) => {
    setMode(next);
    window.localStorage.setItem('sooner-mode', next);
  }, []);

  const setRole = useCallback((next: DemoRole) => {
    setRoleState(next);
    window.localStorage.setItem('sooner-role', next);
  }, []);

  const enterDemo = useCallback(() => {
    const pair = {
      buyer: loadDemoKeypair('buyer', true) as Keypair,
      supplier: loadDemoKeypair('supplier', true) as Keypair,
    };
    setDemo(pair);
    persistMode('demo');
    return pair;
  }, [persistMode]);

  const leave = useCallback(() => {
    if (wallet) void disconnectWallet(wallet).catch(() => undefined);
    setWallet(null);
    setWalletKey(null);
    persistMode('none');
  }, [persistMode, wallet]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextToast.current++;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.kind === 'error' ? 12_000 : 8_000);
    },
    [dismiss],
  );

  const notify = useCallback((kind: Toast['kind'], text: string) => push({ kind, text }), [push]);

  const connect = useCallback(
    async (chosen: SolanaWallet) => {
      try {
        const account = await connectWallet(chosen);
        if (!account) throw new Error('The wallet did not share an account.');
        setWallet(chosen);
        setWalletKey({ key: new PublicKey(account.address), account });
        window.localStorage.setItem('sooner-wallet', chosen.name);
        persistMode('wallet');
      } catch (error) {
        push({ kind: 'error', text: `Could not connect ${chosen.name}. ${explain(error)}` });
      }
    },
    [persistMode, push],
  );

  const demoSigner = mode === 'demo' && demo ? demo[role] : null;
  const address = demoSigner ? demoSigner.publicKey : mode === 'wallet' && walletKey ? walletKey.key : null;

  const send = useCallback(
    async (label: string, instructions: TransactionInstruction[], as?: Keypair) => {
      const keypair = as ?? demoSigner;
      const feePayer = keypair ? keypair.publicKey : walletKey?.key;
      if (!feePayer || (!keypair && !(wallet && walletKey))) {
        push({ kind: 'error', text: 'Connect a wallet or start the demo first.' });
        return null;
      }
      setBusy(label);
      try {
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new Transaction({ feePayer, ...latest }).add(...instructions);
        let signed: Transaction;
        if (keypair) {
          transaction.sign(keypair);
          signed = transaction;
        } else {
          signed = await signWithWallet(wallet!, walletKey!.account, transaction);
        }
        const signature = await connection.sendRawTransaction(signed.serialize());
        const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
        if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
        push({ kind: 'ok', text: label, signature });
        setVersion((v) => v + 1);
        return signature;
      } catch (error) {
        push({ kind: 'error', text: `${label} did not go through. ${explain(error)}` });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [connection, demoSigner, push, wallet, walletKey],
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const value: Session = {
    connection,
    program,
    ready,
    mode,
    role,
    setRole,
    address,
    demo,
    enterDemo,
    wallets,
    wallet,
    connect,
    leave,
    send,
    busy,
    version,
    refresh,
    toasts,
    notify,
    dismiss,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Loads data, reloads when `deps` change, and can poll. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    const run = (quiet: boolean) => {
      if (!quiet) setLoading(true);
      loadRef
        .current()
        .then((result) => {
          if (cancelled) return;
          setData(result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(explain(cause));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    run(false);
    const timer = pollMs ? window.setInterval(() => run(true), pollMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

/** The current unix time, ticking once a second. Null until the page is live in the browser. */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
