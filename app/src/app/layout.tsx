import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/archivo/wdth.css';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Sooner: get paid before the due date',
  description:
    'Early payment on approved invoices. The supplier picks the day, the buyer keeps the discount, and Solana settles it in about a second.',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3f5f2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
