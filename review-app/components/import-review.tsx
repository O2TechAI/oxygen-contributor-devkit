'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { parseReviewImportFile } from '@/lib/review-import';
import type { Review } from '@/lib/review-types';

export function ImportReview({
  disabled = false,
  onImported,
}: {
  disabled?: boolean;
  onImported: (review: Review) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<Awaited<
    ReturnType<typeof parseReviewImportFile>
  > | null>(null);

  async function readFile(file?: File) {
    setPrepared(null);
    setError('');
    if (!file) return;
    setPending(true);
    try {
      setPrepared(await parseReviewImportFile(await file.text()));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to read this file.',
      );
    } finally {
      setPending(false);
    }
  }

  async function importReview() {
    if (!prepared || pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prepared.payload),
      });
      const result = (await response.json()) as {
        review?: Review;
        error?: string;
      };
      if (!response.ok || !result.review) {
        throw new Error(result.error || 'Unable to import this review.');
      }
      onImported(result.review);
      setOpen(false);
      setPrepared(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to import this review.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        setError('');
        setPrepared(null);
      }}
    >
      <SheetTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            title={
              disabled
                ? 'Apply and save your edits before importing'
                : 'Import a prepared run'
            }
          />
        }
      >
        <Upload data-icon="inline-start" />
        Import review
      </SheetTrigger>
      <SheetContent showCloseButton={!pending}>
        <SheetHeader>
          <SheetTitle>Import a trajectory review</SheetTitle>
          <SheetDescription>
            Choose a prepared run JSON file. Its recorded version determines the
            card fields. Importing creates a separate review with pending
            decisions.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 overflow-y-auto px-4">
          <label htmlFor="review-import-file" className="block space-y-2">
            <span className="font-medium">Review import JSON</span>
            <Input
              id="review-import-file"
              type="file"
              accept=".json,application/json"
              disabled={pending}
              onChange={(event) => readFile(event.target.files?.[0])}
            />
          </label>
          {prepared && (
            <div className="space-y-2 rounded-md border p-3" aria-live="polite">
              <p className="font-medium break-words">
                {prepared.payload.projectName}
              </p>
              <p className="break-all text-muted-foreground">
                {prepared.payload.sourcePath}
              </p>
              <p>
                Protocol v{prepared.payload.protocolVersion} ·{' '}
                {prepared.review.insights.length} insights
              </p>
              <p className="capitalize">
                {prepared.review.hierarchy.privacyStatus} ·{' '}
                {prepared.payload.stage} stage
              </p>
              <p className="text-muted-foreground">
                Manifest hashes, fields, and citations verified.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <SheetFooter>
          <Button disabled={!prepared || pending} onClick={importReview}>
            {pending ? 'Processing…' : 'Import and open review'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
