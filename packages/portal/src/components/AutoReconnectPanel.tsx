import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchVaultSecrets, saveReconnectBindings, type ReconnectStatus, type ReconnectCredential } from "../api";
import { Box, BoxRow } from "./ui/Box";
import { Button } from "./ui/Button";
import { Select } from "./ui/Input";
import { relativeTime } from "../format";

function statusLine(status: ReconnectStatus | undefined): string {
  if (status?.last?.ok === true) return `Auto-reconnected ${relativeTime(Math.floor(status.last.at / 1000))}`;
  if (status?.last?.ok === false) {
    return `Auto-reconnect failed${status.last.error ? ` (${status.last.error})` : ""} — reconnect manually`;
  }
  if (status?.dead) return "Session expired";
  if (status?.missing.length) return "Bind credentials to enable";
  return "Auto-reconnect ready";
}

export function AutoReconnectPanel({
  integration,
  credentials,
  status,
  connected,
}: {
  integration: string;
  credentials: ReconnectCredential[];
  status?: ReconnectStatus;
  connected: boolean;
}) {
  const initial = status?.bindings ?? {};
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();
  const { data: secrets } = useQuery({
    queryKey: ["vault"],
    queryFn: fetchVaultSecrets,
    enabled: credentials.length > 0,
  });

  const changed: Record<string, string> = {};
  for (const c of credentials) {
    const next = values[c.key] ?? "";
    if (next !== (initial[c.key] ?? "")) changed[c.key] = next;
  }
  const dirty = Object.keys(changed).length > 0;

  async function onSave() {
    setBusy(true);
    setMsg(null);
    try {
      await saveReconnectBindings(integration, changed);
      setMsg({ ok: true, text: "Bindings saved." });
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box title="Auto-reconnect">
      <BoxRow className="wb-row-stack">
        <span className="wb-detail-val">{statusLine(status)}</span>
        {credentials.length === 0 ? (
          <p className="wb-detail-desc">Signs in again with your existing SSO session</p>
        ) : (
          <>
            <p className="wb-detail-desc">
              Bind vault entries to the credentials this app signs in with. <Link to="/vault">Add a vault entry</Link>
            </p>
            {!connected && <p className="wb-detail-desc">Connect first</p>}
            {credentials.map((c) => (
              <div key={c.key} className="wb-inline-row">
                <label htmlFor={`reconnect-${c.key}`}>{c.label}</label>
                <Select
                  id={`reconnect-${c.key}`}
                  value={values[c.key] ?? ""}
                  disabled={!connected || busy}
                  onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
                >
                  <option value="">— none —</option>
                  {(secrets ?? []).map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </Select>
              </div>
            ))}
            <Button onClick={onSave} disabled={!connected || busy || !dirty}>Save</Button>
          </>
        )}
        {msg && <div className={msg.ok ? "wb-ok" : "ui-form-error"}>{msg.text}</div>}
      </BoxRow>
    </Box>
  );
}
