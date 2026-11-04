'use client';

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ArrowUp, ChevronDown, Sparkles, Square, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  editSupported,
  MAX_MESSAGE_LENGTH,
  type AgentContext,
  type AgentMode,
  type AgentResult,
  type AgentScope,
} from '@/lib/agent-prompt';
import {
  fetchCapabilities,
  SIGN_IN,
  type Capabilities,
  type Provider,
} from '@/lib/agent-capabilities';
import { Segmented } from '@/components/segmented';

type Preferences = {
  provider: Provider['id'];
  model: string;
  effort: string;
  mode: AgentMode;
  scope: AgentScope;
  collapsed: boolean;
};

const STORAGE_KEY = 'oxygen-agent-composer';

function readPreferences(): Preferences {
  const fallback: Preferences = {
    provider: 'codex',
    model: '',
    effort: '',
    mode: 'ask',
    scope: 'card',
    collapsed: false,
  };
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Partial<Preferences>;
    return {
      provider: saved.provider === 'claude' ? 'claude' : 'codex',
      model: typeof saved.model === 'string' ? saved.model : '',
      effort: typeof saved.effort === 'string' ? saved.effort : '',
      mode: saved.mode === 'edit' ? 'edit' : 'ask',
      scope: saved.scope === 'review' ? 'review' : 'card',
      collapsed: saved.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

const selectClass =
  'h-7 max-w-[11rem] cursor-pointer truncate rounded-[4px] border-0 bg-transparent px-1.5 text-xs text-muted-foreground outline-none hover:bg-[color:var(--ui-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50';

export function AgentComposer({
  protocolVersion,
  focusLabel,
  disabled,
  getContext,
  onEdit,
  onUndo,
}: {
  protocolVersion: number;
  /** Shown as the target of "This card", e.g. "I003". */
  focusLabel: string | undefined;
  disabled: boolean;
  getContext: () => AgentContext;
  /** Apply proposed cards to the review; returns what changed. */
  onEdit: (
    result: AgentResult,
    message: string,
  ) => { changed: string[]; added: string[] };
  onUndo: () => void;
}) {
  const [capabilities, setCapabilities] = useState<Capabilities>({
    state: 'loading',
  });
  const [preferences, setPreferences] = useState(readPreferences);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [answer, setAnswer] = useState('');
  const [applied, setApplied] = useState<{
    changed: string[];
    added: string[];
  } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not remembering the choice is harmless.
      }
      return next;
    });
  }, []);

  const loadCapabilities = useCallback(() => {
    void fetchCapabilities().then(setCapabilities);
  }, []);

  useEffect(() => {
    loadCapabilities();
  }, [loadCapabilities]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => setSeconds((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      update({ collapsed: false });
      window.setTimeout(() => input.current?.focus(), 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [update]);

  const providers =
    capabilities.state === 'ready' ? capabilities.providers : [];
  const provider = providers.find((item) => item.id === preferences.provider);
  const model =
    provider?.models.find((item) => item.id === preferences.model) ??
    provider?.models[0];
  const effort = model?.efforts.includes(preferences.effort)
    ? preferences.effort
    : model?.defaultEffort;
  const usable = Boolean(provider?.installed && provider.signedIn && model);
  const canEdit = editSupported(protocolVersion);
  const mode: AgentMode = canEdit ? preferences.mode : 'ask';
  const scope: AgentScope = focusLabel ? preferences.scope : 'review';

  function chooseProvider(id: Provider['id']) {
    const next = providers.find((item) => item.id === id);
    const first = next?.models[0];
    update({
      provider: id,
      model: first?.id ?? '',
      effort: first?.defaultEffort ?? '',
    });
  }

  function chooseModel(id: string) {
    const next = provider?.models.find((item) => item.id === id);
    update({
      model: id,
      effort: next?.efforts.includes(preferences.effort)
        ? preferences.effort
        : (next?.defaultEffort ?? ''),
    });
  }

  async function send() {
    const text = message.trim();
    if (!text || running || disabled || !usable || !model || !effort) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setSeconds(0);
    setError('');
    setAnswer('');
    setApplied(null);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: preferences.provider,
          model: model.id,
          effort,
          mode,
          scope,
          message: text,
          context: getContext(),
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as AgentResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || 'The request failed.');
      setAnswer(result.answer);
      if (mode === 'edit') setApplied(onEdit(result, text));
      setMessage('');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof Error ? failure.message : 'The request failed.',
        );
      }
    } finally {
      abort.current = null;
      setRunning(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      event.currentTarget.blur();
    }
  }

  if (preferences.collapsed) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center">
        <Button
          variant="outline"
          className="pointer-events-auto rounded-full bg-background/95 shadow-[var(--ui-shadow)] backdrop-blur"
          onClick={() => update({ collapsed: false })}
        >
          <Sparkles data-icon="inline-start" />
          Ask or edit with an agent
        </Button>
      </div>
    );
  }

  const status =
    capabilities.state === 'loading'
      ? 'Checking for Codex and Claude…'
      : capabilities.state === 'off'
        ? capabilities.reason === 'not-configured'
          ? 'Agent connection is off. Start the bridge with npm run agent-bridge.'
          : 'The agent bridge is not reachable.'
        : !provider?.installed
          ? `${provider?.label ?? 'This agent'} is not installed on this computer.`
          : !provider.signedIn
            ? `Sign in first: ${SIGN_IN[provider.id]}`
            : '';

  return (
    <section
      aria-label="Agent"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4"
    >
      <div className="pointer-events-auto w-full max-w-[760px] rounded-[16px] border bg-background/95 shadow-[0_8px_32px_rgba(15,15,15,0.12)] backdrop-blur">
        {(answer || error || running || status) && (
          <div className="max-h-52 overflow-y-auto border-b px-4 py-3 text-sm leading-6">
            {running ? (
              <p className="text-muted-foreground">
                {mode === 'edit' ? 'Revising' : 'Thinking'}… {seconds}s
              </p>
            ) : error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : answer ? (
              <>
                <p className="whitespace-pre-wrap">{answer}</p>
                {applied && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {applied.changed.length || applied.added.length
                        ? [
                            applied.changed.length &&
                              `Changed ${applied.changed.join(', ')}`,
                            applied.added.length &&
                              `Added ${applied.added.join(', ')}`,
                          ]
                            .filter(Boolean)
                            .join(' · ') + '. Pending your review.'
                        : 'No cards were changed.'}
                    </span>
                    {(applied.changed.length > 0 ||
                      applied.added.length > 0) && (
                      <Button size="sm" variant="ghost" onClick={onUndo}>
                        <Undo2 data-icon="inline-start" />
                        Undo
                      </Button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">{status}</p>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 px-3 pt-3">
          <textarea
            ref={input}
            aria-label="Message to the agent"
            rows={1}
            maxLength={MAX_MESSAGE_LENGTH}
            value={message}
            disabled={disabled}
            placeholder={
              mode === 'edit'
                ? 'Describe the change, e.g. shorten the example'
                : 'Ask about this review  ( / )'
            }
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50 [field-sizing:content]"
          />
          {running ? (
            <Button
              size="icon"
              variant="outline"
              aria-label="Stop"
              title="Stop"
              onClick={() => abort.current?.abort()}
            >
              <Square />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="Send"
              title="Send (Enter)"
              disabled={disabled || !usable || !message.trim()}
              onClick={() => void send()}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-1 pb-2">
          <Segmented
            label="Agent mode"
            value={mode}
            onChange={(value) => update({ mode: value })}
            options={[
              { id: 'ask', text: 'Ask' },
              {
                id: 'edit',
                text: 'Edit',
                disabled: !canEdit,
                title: canEdit
                  ? undefined
                  : 'Editing is available for skill-candidate (v9) reviews',
              },
            ]}
          />
          <Segmented
            label="Agent scope"
            value={scope}
            onChange={(value) => update({ scope: value })}
            options={[
              {
                id: 'card',
                text: focusLabel ? `Card ${focusLabel}` : 'Card',
                disabled: !focusLabel,
              },
              { id: 'review', text: 'Whole review' },
            ]}
          />
          <span className="flex-1" />
          <select
            aria-label="Agent"
            className={selectClass}
            value={preferences.provider}
            disabled={capabilities.state !== 'ready' || running}
            onChange={(event) =>
              chooseProvider(event.target.value as Provider['id'])
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
          <select
            aria-label="Model"
            className={selectClass}
            value={model?.id ?? ''}
            disabled={!usable || running}
            onChange={(event) => chooseModel(event.target.value)}
          >
            {(provider?.models ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Reasoning effort"
            className={selectClass}
            value={effort ?? ''}
            disabled={!usable || running}
            onChange={(event) => update({ effort: event.target.value })}
          >
            {(model?.efforts ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Collapse"
            title="Collapse"
            onClick={() => update({ collapsed: true })}
          >
            <ChevronDown />
          </Button>
        </div>
      </div>
    </section>
  );
}
