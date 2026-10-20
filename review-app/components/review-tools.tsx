'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Keep children mounted so an opened import/help dialog survives closing the tools. */
export function ReviewTools({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function choose(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const button = target.closest('button:not(:disabled)');
      if (
        root.current?.contains(target) &&
        button &&
        button !== trigger.current
      ) {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener('click', choose);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('click', choose);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <Button
        ref={trigger}
        variant="ghost"
        size="icon-sm"
        aria-label="More review actions"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal />
      </Button>
      <div
        hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border bg-background p-1.5 shadow-lg [&_button]:w-full [&_button]:justify-start"
      >
        {children}
      </div>
    </div>
  );
}
