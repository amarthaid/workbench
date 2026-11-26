export type Effect = "allow" | "deny";

export interface CapabilityDef {
  default: Effect;
  label: string;
  description: string;
}

// Every capability a per-user rule can set. A key missing here is never
// granted, whatever rows the table holds.
export const CAPABILITIES = {
  "spaces.delegate_access": {
    default: "deny",
    label: "Delegate access in Spaces",
    description: "Lets this user share Spaces that run with their connected apps.",
  },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = keyof typeof CAPABILITIES;

export function capabilityDef(key: string): CapabilityDef | undefined {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, key)
    ? (CAPABILITIES as Record<string, CapabilityDef>)[key]
    : undefined;
}
