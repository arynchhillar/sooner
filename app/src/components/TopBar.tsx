'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/lib/session';
import { Addr } from './Bits';

function Mark() {
  // The wedge from the payout chart: the discount shrinking to the due date.
  return (
    <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
      <polygon points="1,2 25,2 1,16" fill="var(--sun)" />
      <line x1="1" y1="18.5" x2="25" y2="18.5" stroke="var(--ink)" strokeWidth="2" />
    </svg>
  );
}

function ConnectMenu({ onPicked }: { onPicked: () => void }) {
  const session = useSession();
  const usable = session.wallets;
  return (
    <div className="menu" role="menu">
      {usable.map((w) => (
        <button
          key={w.name}
          type="button"
          role="menuitem"
          onClick={() => {
            onPicked();
            void session.connect(w);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={w.icon} alt="" />
          {w.name}
        </button>
      ))}
      {usable.length === 0 && (
        <p className="small muted">
          No Solana wallet was found in this browser. Use the demo wallet, or install Phantom or Solflare and
          switch it to devnet.
        </p>
      )}
    </div>
  );
}

export function TopBar() {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!sessionRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const links = [
    { href: '/buyer', label: 'Buyer desk', desk: 'buyer' },
    { href: '/supplier', label: 'Supplier desk', desk: 'supplier' },
  ];

  const pickRole = (role: 'buyer' | 'supplier') => {
    session.setRole(role);
    if (pathname === '/buyer' && role === 'supplier') router.push('/supplier');
    if (pathname === '/supplier' && role === 'buyer') router.push('/buyer');
  };

  return (
    <header className="bar">
      <div className="wrap">
        <Link className="brand" href="/">
          <Mark />
          <span className="brand-word" data-text="Sooner">
            Sooner
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              data-text={link.label}
              data-desk={link.desk}
              aria-current={pathname === link.href ? 'page' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="session" ref={sessionRef}>
          {!session.ready ? null : session.mode === 'demo' && session.demo ? (
            <>
              <span className="small muted">Demo wallet</span>
              <div className="seg" role="group" aria-label="Which demo wallet signs">
                <button
                  type="button"
                  data-role="buyer"
                  aria-pressed={session.role === 'buyer'}
                  onClick={() => pickRole('buyer')}
                >
                  Buyer
                </button>
                <button
                  type="button"
                  data-role="supplier"
                  aria-pressed={session.role === 'supplier'}
                  onClick={() => pickRole('supplier')}
                >
                  Supplier
                </button>
              </div>
              <Addr value={session.demo[session.role].publicKey} />
              <button type="button" className="btn small plain" onClick={session.leave}>
                Leave demo
              </button>
            </>
          ) : session.mode === 'wallet' && session.wallet && session.address ? (
            <>
              <span className="small muted">{session.wallet.name}</span>
              <Addr value={session.address} />
              <button type="button" className="btn small plain" onClick={session.leave}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  session.enterDemo();
                  if (pathname !== '/') router.refresh();
                }}
              >
                Use a demo wallet
              </button>
              <button
                type="button"
                className="btn small primary"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                Connect wallet
              </button>
              {menuOpen && <ConnectMenu onPicked={() => setMenuOpen(false)} />}
            </>
          )}
        </div>
      </div>
    </header>
  );
}
