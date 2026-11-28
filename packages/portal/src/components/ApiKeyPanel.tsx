import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApiKeyStatus, mintApiKey, revokeApiKey, revealApiKey } from "../api";
import { MCP_URL, API_KEY_PLACEHOLDER, mcpConfigFor } from "../mcp-config";
import { Button } from "./ui/Button";
import { RowAction, RowActions } from "./ui/RowActions";
function maskKey(k: string): string {
  return "•".repeat(Math.max(8, k.length - 4)) + k.slice(-4);
}

export function useApiKeyStatus() {
  return useQuery({ queryKey: ["api-key-status"], queryFn: getApiKeyStatus });
}

export default function ApiKeyPanel() {
  const queryClient = useQueryClient();
  const { data } = useApiKeyStatus();

  // Plaintext key. Held after minting; also refetchable via reveal.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [show, setShow] = useState(false); // masked by default
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const hasKey = data?.hasKey ?? false;

  async function handleMint() {
    setBusy(true);
    setError(null);
    try {
      const { apiKey } = await mintApiKey();
      setRevealed(apiKey);
      setShow(false);
      queryClient.invalidateQueries({ queryKey: ["api-key-status"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleReveal() {
    setBusy(true);
    setError(null);
    try {
      const { apiKey } = await revealApiKey();
      setRevealed(apiKey);
      setShow(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeApiKey();
      setRevealed(null);
      queryClient.invalidateQueries({ queryKey: ["api-key-status"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, tag: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  // The key value to render in the config snippet: real (masked or shown) when
  // freshly minted, else a placeholder so the snippet is always present.
  const snippetKey = revealed ? (show ? revealed : maskKey(revealed)) : API_KEY_PLACEHOLDER;
  // Copy always uses the real key when we have it.
  const copyKey = revealed ?? API_KEY_PLACEHOLDER;

  return (
    <div className="wb-row-stack apikey-panel">
      <p className="apikey-blurb">
        Send this key in the <code>x-workbench-api-key</code> header to{" "}
        <code>{MCP_URL}</code>. Reveal it anytime below.
      </p>

      {error && <div className="ui-form-error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Freshly minted key — masked by default, with Show toggle + copy. */}
      {revealed && (
        <div className="apikey-reveal">
          <div className="apikey-row">
            <code className="apikey-value">{show ? revealed : maskKey(revealed)}</code>
            <Button variant="ghost" onClick={() => setShow((s) => !s)}>
              {show ? "Hide" : "Show"}
            </Button>
            <Button variant="ghost" onClick={() => copy(revealed, "key")}>
              {copied === "key" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      {/* Config snippet — always visible once a key exists or was just minted. */}
      {(revealed || hasKey) && (
        <div className="apikey-reveal" style={{ marginTop: 10 }}>
          <pre className="wb-code"><code>{mcpConfigFor(snippetKey)}</code></pre>
          <div className="wb-inline-row">
            <Button variant="outline" onClick={() => copy(mcpConfigFor(copyKey), "cfg")}>
              {copied === "cfg" ? "Copied" : "Copy config"}
            </Button>
            {!revealed && (
              <Button variant="outline" onClick={handleReveal} disabled={busy}>
                {busy ? "…" : "Reveal key"}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="apikey-actions" style={{ marginTop: 14 }}>
        {hasKey || revealed ? (
          <RowActions>
            <RowAction onClick={handleMint} disabled={busy}>
              {busy ? "Working…" : "Regenerate key"}
            </RowAction>
            <RowAction danger onClick={handleRevoke} disabled={busy}>
              Revoke
            </RowAction>
          </RowActions>
        ) : (
          <Button onClick={handleMint} disabled={busy}>
            {busy ? "Working…" : "Generate key"}
          </Button>
        )}
      </div>
    </div>
  );
}
