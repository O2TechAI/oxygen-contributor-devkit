'use client';

import Link from 'next/link';
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from 'react';
import { Sparkles, X } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { InsightJobsContext, useInsightJobs } from '@/hooks/use-insight-jobs';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Access = 'checking' | 'signed_out' | 'signed_in';

function LoginCard({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('Oxygen');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(result?.error || 'Unable to sign in.');
      }
      onSignedIn();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to sign in.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-sm rounded-lg border bg-card p-7 shadow-sm">
        <span className="grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-5" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold">Oxygen</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Sign in to continue.
        </p>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          <label className="block space-y-2" htmlFor="login-username">
            <span className="text-xs font-medium text-muted-foreground">
              Account
            </span>
            <Input
              id="login-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label className="block space-y-2" htmlFor="login-password">
            <span className="text-xs font-medium text-muted-foreground">
              Password
            </span>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button className="w-full" type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </section>
    </main>
  );
}

const NAV = [
  { id: 'projects', href: '/', label: 'Projects' },
  { id: 'review', href: '/review', label: 'Review' },
] as const;

/** The signed-in frame shared by the Oxygen pages: access check, header, content. */
export function AppShell({
  active,
  children,
}: {
  /** The highlighted header link; submission pages highlight none. */
  active: (typeof NAV)[number]['id'] | 'submit';
  children: ReactNode;
}) {
  const [access, setAccess] = useState<Access>('checking');
  const [configured, setConfigured] = useState(false);
  const jobs = useInsightJobs(access === 'signed_in');
  const announced = jobs.ready[0];

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to check the session.');
        return (await response.json()) as {
          authenticated: boolean;
          configured: boolean;
        };
      })
      .then((session) => {
        if (cancelled) return;
        setConfigured(session.configured);
        setAccess(session.authenticated ? 'signed_in' : 'signed_out');
      })
      .catch(() => {
        if (!cancelled) setAccess('signed_out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    setAccess('signed_out');
  }

  if (access === 'checking') {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        Checking access…
      </main>
    );
  }
  if (access === 'signed_out') {
    return <LoginCard onSignedIn={() => setAccess('signed_in')} />;
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1040px] items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2"
            title="Oxygen home"
          >
            <span className="grid size-6 place-items-center rounded-[4px] bg-foreground text-background">
              <Sparkles className="size-3.5" />
            </span>
            <span className="text-sm font-medium">Oxygen</span>
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active === item.id ? 'page' : undefined}
                className={cn(
                  'rounded-[4px] px-2.5 py-1 text-sm transition-colors',
                  active === item.id
                    ? 'bg-[color:var(--ui-hover)] text-foreground'
                    : 'text-muted-foreground hover:bg-[color:var(--ui-hover)] hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            ))}
            {configured && (
              <Button variant="ghost" size="sm" onClick={signOut}>
                Sign out
              </Button>
            )}
          </nav>
        </div>
      </header>
      {announced && (
        <output className="block border-b bg-[color:var(--ui-callout)] px-4 py-2 sm:px-6">
          <span className="mx-auto flex max-w-[1040px] items-center justify-between gap-3 text-sm">
            <span>
              {announced.job.candidateCount === 1
                ? '1 cross-session insight is ready to review.'
                : `${announced.job.candidateCount} cross-session insights are ready to review.`}
            </span>
            <span className="flex items-center gap-1">
              <Link
                href={`/review?review=${announced.reviewId}`}
                onClick={() => jobs.dismiss(announced.job.id)}
                className={buttonVariants({ size: 'sm' })}
              >
                Open
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                onClick={() => jobs.dismiss(announced.job.id)}
              >
                <X />
              </Button>
            </span>
          </span>
        </output>
      )}
      <InsightJobsContext.Provider value={jobs}>
        {children}
      </InsightJobsContext.Provider>
    </div>
  );
}
