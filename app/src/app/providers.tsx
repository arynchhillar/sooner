'use client';

import { Buffer } from 'buffer';
import type { ReactNode } from 'react';
import { Foot, Toasts } from '@/components/Bits';
import { TopBar } from '@/components/TopBar';
import { SessionProvider } from '@/lib/session';

// The Solana libraries expect Node's Buffer to exist in the browser.
if (typeof globalThis !== 'undefined' && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <TopBar />
      <main className="wrap">{children}</main>
      <Foot />
      <Toasts />
    </SessionProvider>
  );
}
