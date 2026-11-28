import { useState } from "react";
import { Segmented } from "./Segmented";

type Theme = "light" | "dark";

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("wb-theme", next);
  } catch {
    // Storage may be unavailable (private mode); the DOM attribute still
    // switches for this page load.
  }
}

/** The theme as a labeled choice, for Settings. There is no System option: the app follows the OS only until a theme is chosen. */
export function ThemeSegmented() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  return (
    <Segmented
      label="Theme"
      value={theme}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ]}
      onChange={(next) => {
        applyTheme(next);
        setTheme(next);
      }}
    />
  );
}

export function ThemeToggle() {
  function handleClick() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  return (
    <button type="button" className="theme-toggle" onClick={handleClick} aria-label="Toggle theme">
      <span className="theme-toggle-sun" aria-hidden>☀</span>
      <span className="theme-toggle-moon" aria-hidden>☾</span>
    </button>
  );
}
