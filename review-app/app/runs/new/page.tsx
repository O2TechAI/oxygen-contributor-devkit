'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check } from 'lucide-react';

import { AppShell } from '@/components/oxygen/app-shell';
import { ServiceNotice } from '@/components/oxygen/service-notice';
import { Segmented } from '@/components/segmented';
import { Button } from '@/components/ui/button';
import {
  fetchCapabilities,
  readSavedChoice,
  resolveChoice,
  saveChoice,
  SIGN_IN,
  type AgentChoice,
  type Capabilities,
} from '@/lib/agent-capabilities';
import {
  api,
  ApiError,
  postJson,
  type RunLanguage,
  type SessionInfo,
} from '@/lib/oxygen-api';
import { formatBytes, formatDate } from '@/lib/run-progress';
import { cn } from '@/lib/utils';

const LANGUAGE_KEY = 'oxygen-run-language';
const SOURCE_LABEL = { codex: 'Codex', claude: 'Claude Code' } as const;
const selectClass =
  'h-8 w-full cursor-pointer rounded-[4px] border border-[color:var(--input)] bg-background px-2 text-sm outline-none hover:bg-[color:var(--ui-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50';

function initialLanguage(): RunLanguage {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // Fall through to the browser's language.
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium">{title}</h2>
      {hint && (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{hint}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const keyOf = (item: SessionInfo) => `${item.source}:${item.id}`;

export default function NewRunPage() {
  return (
    <AppShell active="projects">
      <NewRun />
    </AppShell>
  );
}

/** Rendered only once access is confirmed, so it can read the address and storage directly. */
function NewRun() {
  const [workspace] = useState(
    () => new URLSearchParams(window.location.search).get('workspace') ?? '',
  );
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState<RunLanguage>(initialLanguage);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    state: 'loading',
  });
  const [choice, setChoice] = useState<AgentChoice>(readSavedChoice);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void fetchCapabilities().then(setCapabilities);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    api<{ sessions: SessionInfo[] }>(
      `/api/oxygen/sessions?workspace=${encodeURIComponent(workspace)}`,
    )
      .then(({ sessions: found }) => {
        if (cancelled) return;
        // Newest first reads naturally; the run still processes them in order.
        const ordered = [...found].reverse();
        setSessions(ordered);
        setSelected(
          new Set(
            ordered
              .filter((item) => item.suggested)
              .map((item) => `${item.source}:${item.id}`),
          ),
        );
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        if (failure instanceof ApiError && failure.status === 401) {
          window.location.reload();
        } else if (failure instanceof ApiError && failure.reason) {
          setUnavailable(failure.reason);
        } else {
          setError(
            failure instanceof Error ? failure.message : 'Unable to load.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const providers =
    capabilities.state === 'ready' ? capabilities.providers : [];
  const resolved = resolveChoice(providers, choice);
  const name = workspace.split('/').filter(Boolean).pop() ?? workspace;
  const suggestedKeys = useMemo(
    () => (sessions ?? []).filter((item) => item.suggested).map(keyOf),
    [sessions],
  );
  const canStart =
    !starting && selected.size > 0 && resolved.usable && !unavailable;

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function chooseLanguage(value: RunLanguage) {
    setLanguage(value);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, value);
    } catch {
      // Not remembering the choice is harmless.
    }
  }

  function update(next: AgentChoice) {
    setChoice(next);
    saveChoice(next);
  }

  function chooseProvider(id: AgentChoice['provider']) {
    const provider = providers.find((item) => item.id === id);
    const first = provider?.models[0];
    update({
      provider: id,
      model: first?.id ?? '',
      effort: first?.defaultEffort ?? '',
    });
  }

  function chooseModel(id: string) {
    const model = resolved.provider?.models.find((item) => item.id === id);
    update({
      provider: choice.provider,
      model: id,
      effort: model?.efforts.includes(resolved.effort ?? '')
        ? (resolved.effort ?? '')
        : (model?.defaultEffort ?? ''),
    });
  }

  async function start() {
    if (!canStart || !resolved.provider || !resolved.model || !resolved.effort)
      return;
    setStarting(true);
    setError('');
    try {
      const picked = (sessions ?? []).filter((item) =>
        selected.has(keyOf(item)),
      );
      const { id } = await postJson<{ id: string }>('/api/oxygen/runs', {
        workspace,
        language,
        provider: resolved.provider.id,
        model: resolved.model.id,
        effort: resolved.effort,
        sessions: picked.map((item) => ({ source: item.source, id: item.id })),
      });
      window.location.assign(`/runs?id=${id}`);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to start the run.',
      );
      setStarting(false);
    }
  }

  const providerLabel = resolved.provider?.label ?? 'your agent';

  return (
    <>
      <main className="mx-auto w-full max-w-[760px] px-4 py-8 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Projects
        </Link>
        <h1 className="mt-3 text-xl font-semibold">New run</h1>
        <p
          className="mt-1 truncate font-mono text-xs text-muted-foreground"
          title={workspace}
        >
          {workspace || 'No project selected'}
        </p>

        {!workspace ? (
          <p className="mt-8 text-sm text-muted-foreground">
            Choose a project on the{' '}
            <Link href="/" className="underline">
              Projects page
            </Link>{' '}
            first.
          </p>
        ) : unavailable ? (
          <ServiceNotice reason={unavailable} />
        ) : (
          <>
            <Section
              title="Sessions"
              hint="Each selected session becomes one trajectory with a summary and skill-candidate insights."
            >
              {sessions === null ? (
                <p className="text-sm text-muted-foreground">
                  {error || 'Loading sessions…'}
                </p>
              ) : sessions.length === 0 ? (
                <p className="rounded-[6px] border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                  No sessions were recorded for {name}.
                </p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {selected.size} of {sessions.length} selected
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="The earliest, a middle and the latest session"
                        onClick={() => setSelected(new Set(suggestedKeys))}
                      >
                        Suggested
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setSelected(new Set(sessions.map(keyOf)))
                        }
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                  <ul className="max-h-[360px] divide-y overflow-y-auto rounded-[6px] border bg-card">
                    {sessions.map((item) => {
                      const key = keyOf(item);
                      return (
                        <li key={key}>
                          <label className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-[color:var(--ui-hover)]">
                            <input
                              type="checkbox"
                              className="peer sr-only"
                              checked={selected.has(key)}
                              onChange={() => toggle(key)}
                            />
                            <span
                              aria-hidden="true"
                              className={cn(
                                'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] border peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
                                selected.has(key)
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-[color:var(--input)] bg-background',
                              )}
                            >
                              {selected.has(key) && (
                                <Check className="size-3" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="sr-only">Select session: </span>
                              <span
                                className={cn(
                                  'block truncate text-sm',
                                  !item.title && 'text-muted-foreground',
                                )}
                              >
                                {item.title ||
                                  'Session without a typed request'}
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {SOURCE_LABEL[item.source]} ·{' '}
                                {formatDate(item.started)} ·{' '}
                                {formatBytes(item.bytes)}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </Section>

            <Section
              title="Language"
              hint={
                language === 'zh'
                  ? 'Summaries and cards are written in Chinese. Technical terms, code and file names stay in English.'
                  : 'Summaries and cards are written in English.'
              }
            >
              <Segmented
                label="Language of the summaries and cards"
                size="md"
                value={language}
                onChange={chooseLanguage}
                options={[
                  { id: 'zh', text: '中文' },
                  { id: 'en', text: 'English' },
                ]}
              />
            </Section>

            <Section
              title="Agent"
              hint={`${providerLabel} runs on this computer with your own login and does the writing.`}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="run-agent"
                    className="block text-xs text-muted-foreground"
                  >
                    Agent
                  </label>
                  <select
                    id="run-agent"
                    className={selectClass}
                    value={resolved.provider?.id ?? choice.provider}
                    disabled={capabilities.state !== 'ready'}
                    onChange={(event) =>
                      chooseProvider(
                        event.target.value as AgentChoice['provider'],
                      )
                    }
                  >
                    {(providers.length
                      ? providers
                      : [
                          { id: 'codex', label: 'Codex' },
                          { id: 'claude', label: 'Claude' },
                        ]
                    ).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="run-model"
                    className="block text-xs text-muted-foreground"
                  >
                    Model
                  </label>
                  <select
                    id="run-model"
                    className={selectClass}
                    value={resolved.model?.id ?? ''}
                    disabled={!resolved.usable}
                    onChange={(event) => chooseModel(event.target.value)}
                  >
                    {(resolved.provider?.models ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="run-effort"
                    className="block text-xs text-muted-foreground"
                  >
                    Reasoning effort
                  </label>
                  <select
                    id="run-effort"
                    className={selectClass}
                    value={resolved.effort ?? ''}
                    disabled={!resolved.usable}
                    onChange={(event) =>
                      update({
                        provider: choice.provider,
                        model: resolved.model?.id ?? '',
                        effort: event.target.value,
                      })
                    }
                  >
                    {(resolved.model?.efforts ?? []).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {capabilities.state === 'off' && (
                <p className="mt-3 text-sm text-muted-foreground">
                  The agents could not be detected because the Oxygen service is
                  not running.
                </p>
              )}
              {capabilities.state === 'ready' && !resolved.usable && (
                <p className="mt-3 text-sm text-muted-foreground">
                  No agent is ready. Sign in with{' '}
                  <code className="font-mono text-xs">{SIGN_IN.codex}</code> or{' '}
                  <code className="font-mono text-xs">{SIGN_IN.claude}</code>,
                  then reload.
                </p>
              )}
            </Section>

            <div className="mt-10 flex flex-wrap items-center gap-4 border-t pt-5">
              <Button
                size="lg"
                disabled={!canStart}
                onClick={() => void start()}
              >
                {starting
                  ? 'Starting…'
                  : selected.size === 1
                    ? 'Process 1 session'
                    : `Process ${selected.size} sessions`}
              </Button>
              <p className="min-w-56 flex-1 text-xs leading-5 text-muted-foreground">
                The selected sessions are read here and their text is sent to{' '}
                {providerLabel} through your login. Nothing is shared with
                anyone else.
              </p>
            </div>
            {error && sessions !== null && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </main>
    </>
  );
}
