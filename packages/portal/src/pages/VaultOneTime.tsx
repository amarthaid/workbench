import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { mintVaultOneTimeLink } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { PopoverSelect } from "../components/ui/PopoverSelect";
import { CheckIcon, ClockIcon, CopyIcon, EyeIcon, EyeOffIcon, LinkIcon, RefreshIcon } from "../components/ui/Icons";

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
      setShowValue(false);
      setMinted(m);
    },
    onError: (e: Error) => setFormError(e.message),
  });

  function submit() {
    if (value === "") return setFormError("Value cannot be empty.");
    setFormError(null);
    mint.mutate({ value, ttl_seconds: ttl });
  }

  // Back to an empty form for the next value. The minted URL is dropped with
  // it: the page never shows a link twice. The expiry choice is kept, and the
  // value field remounts with autoFocus.
  function reset() {
    setMinted(null);
    setCopied(false);
    setFormError(null);
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
        <form
          className="wb-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (minted) reset();
            else submit();
          }}
          autoComplete="off"
        >
          {minted ? (
            <div className="ui-field">
              <span className="ui-field-label">Link</span>
              <span className="wb-input-row">
                <Input
                  value={minted.url}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="One-time link"
                />
                <Button type="button" variant="secondary" onClick={copy}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </span>
            </div>
          ) : (
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
          )}

          {formError && <div className="ui-form-error">{formError}</div>}

          <div className="wb-form-bar">
            <PopoverSelect
              label="Expires if unused after"
              icon={<ClockIcon />}
              value={ttl}
              options={ONE_TIME_TTL_OPTIONS.map((o) => ({ value: o.seconds, label: o.label }))}
              display={(o) => `Expires in ${o.label}`}
              onChange={setTtl}
              disabled={minted !== null || mint.isPending}
            />
            <Button type="submit" disabled={mint.isPending}>
              {minted ? <RefreshIcon /> : <LinkIcon />}
              {minted ? "Create link again" : mint.isPending ? "Creating…" : "Create link"}
            </Button>
          </div>

          <p className="ui-stat-note">
            {minted
              ? `Works exactly once, then never again. Unused, it expires in ${ttlLabel}. Paste it to your agent and tell it to fetch the value straight into a file or a variable, not to print it.`
              : "Not saved to your vault. You get a URL that returns this value once; the value is destroyed on the first download, or when the link expires."}
          </p>
        </form>
      </Box>
    </div>
  );
}
