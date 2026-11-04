import { PlugZap } from 'lucide-react';

/** Shown when the local Oxygen service cannot be reached. */
export function ServiceNotice({ reason }: { reason?: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <PlugZap className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-4 text-lg font-semibold">
        The Oxygen service is not running
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        It finds your Codex and Claude Code sessions and runs the agents on this
        computer. Start everything with{' '}
        <code className="rounded-[3px] bg-[color:var(--ui-hover)] px-1.5 py-0.5 font-mono text-xs text-foreground">
          ./oxygen
        </code>{' '}
        from the toolkit folder
        {reason === 'not-configured' ? ' so the app can reach it' : ''}.
      </p>
    </div>
  );
}
