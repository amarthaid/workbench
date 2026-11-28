const svgProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function EyeIcon() {
  return (
    <svg {...svgProps}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg {...svgProps}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5c1.1 0 2.1.3 3 .8M14.5 8s-2.5 4.5-6.5 4.5c-1.1 0-2.1-.3-3-.8" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
      <path d="M2.5 2.5l11 11" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg {...svgProps}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg {...svgProps}>
      <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8" />
      <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...svgProps}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...svgProps}>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...svgProps}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg {...svgProps}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...svgProps}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** A heart. `filled` is the marked state; the outline is the unmarked one. */
export function HeartIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg {...svgProps} fill={filled ? "currentColor" : "none"}>
      <path d="M8 13.5S2 10 2 5.9A3.4 3.4 0 0 1 8 4a3.4 3.4 0 0 1 6 1.9C14 10 8 13.5 8 13.5z" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...svgProps} fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg {...svgProps}>
      <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5" />
      <path d="M2.5 13.5h11" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg {...svgProps}>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="M7.3 8.7L13.5 2.5M11 5l1.8 1.8M9.3 6.7l1.4 1.4" />
    </svg>
  );
}

export type FileKind = "image" | "table" | "document" | "archive" | "code" | "other";

/** A page glyph with a small mark for the kind of file. */
export function FileIcon({ kind = "other" }: { kind?: FileKind }) {
  return (
    <svg {...svgProps}>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
      {kind === "image" && <path d="M5.5 12l2-2.5 1.5 1.5 1.5-2 1 3" />}
      {kind === "table" && <path d="M5.5 8h5M5.5 10.5h5M8 7v6" />}
      {kind === "document" && <path d="M5.5 8h5M5.5 10h5M5.5 12h3" />}
      {kind === "archive" && <path d="M8 6v1.5M8 9v1.5M8 12v1" />}
      {kind === "code" && <path d="M7 8.5L5.5 10 7 11.5M9 8.5L10.5 10 9 11.5" />}
    </svg>
  );
}

export function DoorOpenIcon() {
  return (
    <svg {...svgProps}>
      <path d="M2 14h12" />
      <path d="M4 14V2.5l6-1.2V14" />
      <path d="M10 3.5h2V14" />
      <path d="M7.5 8.2v.6" />
    </svg>
  );
}
