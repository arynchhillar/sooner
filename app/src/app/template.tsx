import type { ReactNode } from 'react';

/**
 * A template is created afresh on every navigation, so its entrance
 * animation (see .page-enter in globals.css) plays each time a page opens.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
