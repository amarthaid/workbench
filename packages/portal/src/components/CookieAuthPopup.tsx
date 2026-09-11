import { useState } from "react";
import { captureCookies, cancelCookieAuth } from "../api";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import CdpScreencast from "./CdpScreencast";

interface Props {
  integration: string;
  loginUrl: string;
  cdpProxyUrl: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function CookieAuthPopup({ integration, cdpProxyUrl, onClose, onSuccess }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCapture() {
    setCapturing(true);
    setError(null);
    try {
      await captureCookies(integration);
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setCapturing(false);
    }
  }

  async function handleCancel() {
    await cancelCookieAuth(integration);
    onClose();
  }

  return (
    <Modal
      open
      onClose={handleCancel}
      title={<>Pair <span>{integration}</span></>}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={handleCancel}>Cancel</Button>
          <Button onClick={handleCapture} disabled={capturing}>
            {capturing ? "Capturing…" : "Capture session"}
          </Button>
        </>
      }
    >
      <div className="modal-instructions">
        <div><b>01</b> — Complete login in the remote browser below (mouse + keyboard streamed via CDP).</div>
        <div><b>02</b> — Click "Capture session" once authenticated.</div>
      </div>

      <div style={{ padding: 0, background: "#000", marginTop: "var(--s-12)" }}>
        <CdpScreencast cdpProxyUrl={cdpProxyUrl} width={1024} />
      </div>

      {error && <div className="ui-form-error" style={{ marginTop: "var(--s-12)" }}>{error}</div>}
    </Modal>
  );
}
