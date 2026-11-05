'use client';

import Link from 'next/link';
import { useState } from 'react';

import { selectClass } from '@/components/agent-choice-fields';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import type { Session } from '@/lib/trajectory-index';

/**
 * Shown after a trajectory is completed: open the next unfinished one (time
 * order by default, any other on request) or stay. Mount with a fresh `key`
 * each time it opens so the default choice is recomputed.
 */
export function NextTrajectoryDialog({
  open,
  onOpenChange,
  options,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unfinished trajectories, the default first. */
  options: Session[];
  onOpen: (session: Session) => void;
}) {
  const [chosen, setChosen] = useState(options[0]?.key ?? '');
  const target =
    options.find((session) => session.key === chosen) ?? options[0];
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target ? 'Trajectory labeled' : 'Every trajectory is labeled'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? 'Move on to the next trajectory, or stay to keep working on this one.'
              : 'You can submit the labeled trajectories, or stay on this one.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {target && (
          <div className="space-y-1.5">
            <label
              htmlFor="next-trajectory"
              className="block text-xs text-muted-foreground"
            >
              Next trajectory
            </label>
            <select
              id="next-trajectory"
              className={selectClass}
              value={target.key}
              onChange={(event) => setChosen(event.target.value)}
            >
              {options.map((session) => (
                <option key={session.key} value={session.key}>
                  {session.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Stay here</AlertDialogCancel>
          {target ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                onOpen(target);
              }}
            >
              Open next trajectory
            </Button>
          ) : (
            <Link href="/submit" className={buttonVariants()}>
              Submit labeled trajectories
            </Link>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
