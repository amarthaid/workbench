import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, putVaultSecret } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const VAULT_NAME_HELP = "Lowercase letters, digits, and _ . - only (max 64).";

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 8s2.5-4.5 6.5-4.5c1.1 0 2.1.3 3 .8M14.5 8s-2.5 4.5-6.5 4.5c-1.1 0-2.1-.3-3-.8" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
      <path d="M2.5 2.5l11 11" />
    </svg>
  );
}

/**
 * One page for both "add a secret" (/vault/new) and "replace a value"
 * (/vault/:name/replace). A page rather than a dialog: the value field is the
 * one place in the portal a human types a credential, and it deserves a URL,
 * a back link and room, not a 320px overlay on top of the list.
 *
 * The typed value lives only in this component's state and is dropped on
 * unmount — Save and Cancel both navigate away.
 */
export default function VaultSecretForm() {
  const { name: routeName } = useParams();
  const replacing = routeName !== undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState(routeName ?? "");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Replace pre-fills the description from the list so a value-only rotation
  // round-trips it unchanged (the server keeps it when the key is omitted,
  // but the human should see what they are keeping).
  const { data: secrets } = useQuery({
    queryKey: ["vault"],
    queryFn: fetchVaultSecrets,
    enabled: replacing,
  });
  const existing = replacing ? secrets?.find((s) => s.name === routeName) : undefined;
  useEffect(() => {
    if (existing) setDescription(existing.description ?? "");
  }, [existing]);

  const save = useMutation({
    // Wrapped: TanStack passes (variables, context), and the API takes one arg.
    mutationFn: (input: { name: string; value: string; description?: string }) => putVaultSecret(input),
    onSuccess: () => {
      setValue("");
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
      navigate("/vault");
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function submit() {
    if (!VAULT_NAME_RE.test(name)) return setFormError(VAULT_NAME_HELP);
    if (value === "") return setFormError("Value cannot be empty.");
    setFormError(null);
    save.mutate({ name, value, description: description || undefined });
  }

  const title = replacing ? `Replace value of ${routeName}` : "Add secret";

  return (
    <div className="wb-form-column">
      <Link className="wb-page-back" to="/vault">← Vault</Link>
      <PageHeader title={title} />

      <Box className="wb-form-page">
        <form
          className="wb-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          autoComplete="off"
        >
          <label className="ui-field">
            <span className="ui-field-label">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={replacing}
              placeholder="site_password"
              autoComplete="off"
              autoFocus={!replacing}
            />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Description</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Value</span>
            <span className="ui-input-affix">
              <Input
                type={showValue ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                className="ui-input-has-affix"
                autoFocus={replacing}
              />
              <button
                type="button"
                className="ui-input-affix-button"
                onClick={() => setShowValue((v) => !v)}
                aria-pressed={showValue}
                aria-label={showValue ? "Hide value" : "Show value while typing"}
                title={showValue ? "Hide value" : "Show value while typing"}
              >
                {showValue ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </span>
          </label>
          <p className="ui-stat-note">
            {VAULT_NAME_HELP} The value is never shown again after saving; an agent references it as{" "}
            <code>{`{{vault:${VAULT_NAME_RE.test(name) ? name : "NAME"}}}`}</code>.
          </p>
          {formError && <div className="ui-form-error">{formError}</div>}
          <div className="wb-form-actions">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate("/vault")} disabled={save.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </Box>
    </div>
  );
}
