import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { Box, BoxRow } from "../components/ui/Box";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { ThemeSegmented } from "../components/ui/ThemeToggle";
import ApiKeyPanel, { useApiKeyStatus } from "../components/ApiKeyPanel";

const HELP_URL = "https://barockok.github.io/workbench/";

export default function Settings() {
  const { user, logout } = useAuth();
  const { data, isLoading } = useApiKeyStatus();
  const hasKey = data?.hasKey ?? false;

  return (
    <>
      <PageHeader title="Settings" />

      <div className="wb-section-gap">
        <Box
          title="API key"
          action={<Badge variant={hasKey ? "green" : "neutral"}>{isLoading ? "…" : hasKey ? "Key active" : "No key"}</Badge>}
        >
          <BoxRow className="wb-row-stack">
            <ApiKeyPanel />
          </BoxRow>
        </Box>

        <Box title="Appearance">
          <BoxRow>
            <span className="wb-detail-key">Theme</span>
            <span className="wb-detail-val"><ThemeSegmented /></span>
          </BoxRow>
        </Box>

        <Box title="Help">
          <BoxRow>
            <span className="wb-detail-key">Documentation</span>
            <span className="wb-detail-val">
              <a href={HELP_URL} target="_blank" rel="noreferrer noopener">
                workbench documentation
              </a>
            </span>
          </BoxRow>
        </Box>

        <Box title="Account">
          <BoxRow>
            <span className="wb-detail-key">Signed in as</span>
            <span className="wb-detail-val">{user?.email ?? "—"}</span>
          </BoxRow>
          <BoxRow>
            <Button variant="outline" onClick={logout}>Sign out</Button>
          </BoxRow>
        </Box>
      </div>
    </>
  );
}
