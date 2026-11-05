'use client';

import {
  resolveChoice,
  SIGN_IN,
  type AgentChoice,
  type Capabilities,
} from '@/lib/agent-capabilities';

export const selectClass =
  'h-8 w-full cursor-pointer rounded-[4px] border border-[color:var(--input)] bg-background px-2 text-sm outline-none hover:bg-[color:var(--ui-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50';

/**
 * Agent, model and reasoning effort for work that runs on this computer with
 * the contributor's own login. `choice` is what was asked for; the fields show
 * what will actually be used (see resolveChoice).
 */
export function AgentChoiceFields({
  id,
  capabilities,
  choice,
  onChange,
}: {
  id: string;
  capabilities: Capabilities;
  choice: AgentChoice;
  onChange: (choice: AgentChoice) => void;
}) {
  const providers =
    capabilities.state === 'ready' ? capabilities.providers : [];
  const resolved = resolveChoice(providers, choice);

  function chooseProvider(provider: AgentChoice['provider']) {
    const first = providers.find((item) => item.id === provider)?.models[0];
    onChange({
      provider,
      model: first?.id ?? '',
      effort: first?.defaultEffort ?? '',
    });
  }

  function chooseModel(model: string) {
    const found = resolved.provider?.models.find((item) => item.id === model);
    onChange({
      provider: choice.provider,
      model,
      effort: found?.efforts.includes(resolved.effort ?? '')
        ? (resolved.effort ?? '')
        : (found?.defaultEffort ?? ''),
    });
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label
            htmlFor={`${id}-agent`}
            className="block text-xs text-muted-foreground"
          >
            Agent
          </label>
          <select
            id={`${id}-agent`}
            className={selectClass}
            value={resolved.provider?.id ?? choice.provider}
            disabled={capabilities.state !== 'ready'}
            onChange={(event) =>
              chooseProvider(event.target.value as AgentChoice['provider'])
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
            htmlFor={`${id}-model`}
            className="block text-xs text-muted-foreground"
          >
            Model
          </label>
          <select
            id={`${id}-model`}
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
            htmlFor={`${id}-effort`}
            className="block text-xs text-muted-foreground"
          >
            Reasoning effort
          </label>
          <select
            id={`${id}-effort`}
            className={selectClass}
            value={resolved.effort ?? ''}
            disabled={!resolved.usable}
            onChange={(event) =>
              onChange({
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
          The agents could not be detected because the Oxygen service is not
          running.
        </p>
      )}
      {capabilities.state === 'ready' && !resolved.usable && (
        <p className="mt-3 text-sm text-muted-foreground">
          No agent is ready. Sign in with{' '}
          <code className="font-mono text-xs">{SIGN_IN.codex}</code> or{' '}
          <code className="font-mono text-xs">{SIGN_IN.claude}</code>, then
          reload.
        </p>
      )}
    </>
  );
}
