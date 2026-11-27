'use client';

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

type RevealProps = {
  as?: 'div' | 'section' | 'article' | 'h2' | 'ol';
  className?: string;
  id?: string;
  /** Position in a group, used to stagger the entrance. */
  index?: number;
  children: ReactNode;
};

/**
 * Marks an element "out" until it scrolls into view, then "in". The styles
 * for both states live in globals.css. Anything already on screen when the
 * page loads is left alone, and so is everything when the visitor prefers
 * reduced motion, so content is never hidden without a way back.
 */
export function Reveal({ as = 'div', className, id, index = 0, children }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<'out' | 'in' | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (element.getBoundingClientRect().top < window.innerHeight * 0.92) return;

    setState('out');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState('in');
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return createElement(
    as,
    { ref, id, className, 'data-reveal': state, style: { '--i': index } as CSSProperties },
    children,
  );
}

type FieldLine = { x1: number; y1: number; x2: number; y2: number; tone: 'sun' | 'blue'; seconds: number; wait: number };

// Payout lines for three imaginary invoices. Each crosses the whole band and
// rises to its full amount at the right edge, like the chart in the
// calculator. They stay below the headline so the text is never crossed.
const FIELD: FieldLine[] = [
  { x1: -40, y1: 560, x2: 1240, y2: 300, tone: 'sun', seconds: 19, wait: 0.6 },
  { x1: -40, y1: 650, x2: 1240, y2: 440, tone: 'blue', seconds: 25, wait: 6 },
  { x1: 480, y1: 650, x2: 1240, y2: 130, tone: 'blue', seconds: 15, wait: 10 },
];

/** The moving backdrop of the home page: payout lines with a marker climbing each one. */
export function HeroField() {
  return (
    <svg className="hero-field" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      {FIELD.map((line, index) => (
        <g
          key={index}
          className={`hf ${line.tone}`}
          style={
            {
              '--i': index,
              '--x1': `${line.x1}px`,
              '--y1': `${line.y1}px`,
              '--x2': `${line.x2}px`,
              '--y2': `${line.y2}px`,
              '--seconds': `${line.seconds}s`,
              '--wait': `${line.wait}s`,
            } as CSSProperties
          }
        >
          <polygon
            className="hf-ground"
            points={`${line.x1},${line.y1} ${line.x2},${line.y2} ${line.x2},720 ${line.x1},720`}
          />
          <path className="hf-line" d={`M${line.x1},${line.y1} L${line.x2},${line.y2}`} pathLength={1} />
          <circle className="hf-dot" r={5} />
        </g>
      ))}
    </svg>
  );
}
