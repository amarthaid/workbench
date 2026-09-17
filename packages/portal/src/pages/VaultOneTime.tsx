import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { mintVaultOneTimeLink } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Input";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, LinkIcon } from "../components/ui/Icons";

export const ONE_TIME_TTL_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
];
export const ONE_TIME_TTL_DEFAULT = 300;

/**
 * /vault/one-time — a value that is NOT kept in the vault. The server turns
 * it into a URL that returns the value exactly once, then never again, and
 * dies unused at the TTL. The human pastes the URL to an agent; the agent
 * fetches it to a file or a variable where it needs it.
 *
 * The URL is shown once, here. Navigating away drops it — there is no list
 * of pending links and nothing to come back to, on purpose.
 */
export default function VaultOneTime() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [ttl, setTtl] = useState(ONE_TIME_TTL_DEFAULT);
  const [formError, setFormError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ url: string; expires_at: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const mint = useMutation({
    mutationFn: (input: { value: string; ttl_seconds: number }) => mintVaultOneTimeLink(input),
    onSuccess: (m) => {
      setValue("");
      setMinted(m);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function submit() {
    if (value === "") return setFormError("Value cannot be empty.");
    setFormError(null);
    mint.mutate({ value, ttl_seconds: ttl });
  }

  function copy() {
    if (!minted) return;
    navigator.clipboard
      ?.writeText(minted.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setFormError("Copy failed — select the link and copy it by hand."));
  }

  const ttlLabel = ONE_TIME_TTL_OPTIONS.find((o) => o.seconds === ttl)?.label ?? `${ttl} seconds`;

  return (
    <div className="wb-form-column">
      <Link className="wb-page-back" to="/vault">← Vault</Link>
      <PageHeader title="One-time link" />

      <Box className="wb-form-page">
        {minted ? (
          <div className="wb-form">
            <label className="ui-field">
              <span className="ui-field-label">Link</span>
              <Input value={minted.url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="One-time link" />
            </label>
            <p className="ui-stat-note">
              Works exactly once, then never again. Unused, it expires in {ttlLabel}. Paste it to your agent and
              tell it to fetch the value straight into a file or a variable, not to print it.
            </p>
            {formError && <div className="ui-form-error">{formError}</div>}
            <div className="wb-form-actions">
              <Button type="button" onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate("/vault")}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="wb-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            autoComplete="off"
          >
            <label className="ui-field">
              <span className="ui-field-label">Value</span>
              <span className="ui-input-affix">
                <Input
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="new-password"
                  className="ui-input-has-affix"
                  autoFocus
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
            <label className="ui-field">
              <span className="ui-field-label">Expires if unused after</span>
              <Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                {ONE_TIME_TTL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <p className="ui-stat-note">
              Not saved to your vault. You get a URL that returns this value once; the value is destroyed on the
              first fetch, or when the link expires.
            </p>
            {formError && <div className="ui-form-error">{formError}</div>}
            <div className="wb-form-actions">
              <Button type="submit" disabled={mint.isPending}>
                <LinkIcon />
                {mint.isPending ? "Creating…" : "Create link"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate("/vault")} disabled={mint.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Box>
    </div>
  );
}
