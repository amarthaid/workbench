export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

// A choice between a few values, shown as pressed buttons in one frame.
// Each button carries aria-pressed; the group is named by `label`.
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
