import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import type { HeaderRow } from "../api";

const MAX_ROWS = 10;

export function CustomAppHeadersEditor({
  rows,
  onChange,
  disabled,
  valueOptional,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  disabled?: boolean;
  // Edit mode: a blank value keeps the stored one.
  valueOptional?: boolean;
}) {
  const set = (i: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="wb-section-gap">
      {rows.map((r, i) => (
        <div className="ui-field" key={i} style={{ display: "flex", gap: 8 }}>
          <Input
            aria-label={`Header name ${i + 1}`}
            placeholder="X-Api-Key"
            value={r.name}
            onChange={(e) => set(i, { name: e.target.value })}
            disabled={disabled}
          />
          <Input
            aria-label={`Header value ${i + 1}`}
            type="password"
            autoComplete="off"
            placeholder={valueOptional ? "unchanged" : "value"}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            disabled={disabled}
          />
          <Button
            variant="outline"
            type="button"
            aria-label={`Remove header ${i + 1}`}
            disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      {rows.length < MAX_ROWS && (
        <Button
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => onChange([...rows, { name: "", value: "" }])}
        >
          Add header
        </Button>
      )}
    </div>
  );
}
