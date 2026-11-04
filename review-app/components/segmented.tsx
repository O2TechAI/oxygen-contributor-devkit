import { cn } from '@/lib/utils';

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'sm',
}: {
  label: string;
  value: T;
  options: { id: T; text: string; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <fieldset
      aria-label={label}
      className="m-0 flex w-fit min-w-0 items-center rounded-[4px] bg-[color:var(--ui-hover)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={option.disabled}
          title={option.title}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-[3px] transition-colors disabled:opacity-40',
            size === 'md' ? 'h-7 px-3 text-sm' : 'h-6 px-2 text-xs',
            value === option.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.text}
        </button>
      ))}
    </fieldset>
  );
}
