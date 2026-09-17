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
