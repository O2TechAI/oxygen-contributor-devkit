export type Model = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
};
export type ProviderId = 'codex' | 'claude';
export type Provider = {
  id: ProviderId;
  label: string;
  installed: boolean;
  signedIn: boolean;
  models: Model[];
};
export type Capabilities =
  | { state: 'loading' }
  | { state: 'off'; reason: 'not-configured' | 'unreachable' }
  | { state: 'ready'; providers: Provider[] };

export const SIGN_IN: Record<ProviderId, string> = {
  codex: 'codex login',
  claude: 'claude auth login',
};

/** Which agents this computer can run, from the local Oxygen service. */
export async function fetchCapabilities(): Promise<Capabilities> {
  try {
    const response = await fetch('/api/agent', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable.');
    const result = (await response.json()) as
      | { available: true; providers: Provider[] }
      | { available: false; reason: 'not-configured' | 'unreachable' };
    return result.available
      ? { state: 'ready', providers: result.providers }
      : { state: 'off', reason: result.reason };
  } catch {
    return { state: 'off', reason: 'unreachable' };
  }
}

export type AgentChoice = {
  provider: ProviderId;
  model: string;
  effort: string;
};

/**
 * The provider, model and effort that will actually be used for a wanted choice:
 * an unknown model falls back to the provider's first, an unsupported effort to
 * the model's default, and an unusable provider to the first usable one.
 */
export function resolveChoice(providers: Provider[], wanted: AgentChoice) {
  const usableProvider = (item: Provider | undefined) =>
    Boolean(item?.installed && item.signedIn && item.models.length);
  let provider = providers.find((item) => item.id === wanted.provider);
  if (!usableProvider(provider)) {
    provider = providers.find(usableProvider) ?? provider;
  }
  const model =
    provider?.models.find((item) => item.id === wanted.model) ??
    provider?.models[0];
  const effort = model?.efforts.includes(wanted.effort)
    ? wanted.effort
    : model?.defaultEffort;
  return {
    provider,
    model,
    effort,
    usable: Boolean(usableProvider(provider) && model && effort),
  };
}

const STORAGE_KEY = 'oxygen-agent-composer';

/** The agent choice shared by the composer and the run form. */
export function readSavedChoice(): AgentChoice {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Partial<AgentChoice>;
    return {
      provider: saved.provider === 'claude' ? 'claude' : 'codex',
      model: typeof saved.model === 'string' ? saved.model : '',
      effort: typeof saved.effort === 'string' ? saved.effort : '',
    };
  } catch {
    return { provider: 'codex', model: '', effort: '' };
  }
}

export function saveChoice(choice: AgentChoice) {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Record<string, unknown>;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...saved, ...choice }),
    );
  } catch {
    // Not remembering the choice is harmless.
  }
}
