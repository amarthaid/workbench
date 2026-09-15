import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { ThemeToggle } from "../ui/ThemeToggle";
import { BrandLockup } from "../BrandMark";

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="wb-nav-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const HomeIcon = () => <Icon><path d="M2 7l6-5 6 5v6.2a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8z" /></Icon>;
const AppsIcon = () => (
  <Icon>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Icon>
);
const AgentsIcon = () => (
  <Icon>
    <path d="M5 1.5v3M11 1.5v3" />
    <rect x="3" y="4.5" width="10" height="5" rx="1" />
    <path d="M8 9.5v5" />
  </Icon>
);
const ActivityIcon = () => <Icon><path d="M1 8h3l2-5.5L10 13l2-5h3" /></Icon>;
const FilesIcon = () => (
  <Icon>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 2h4.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Icon>
);
// A toothed cog, not a hub-and-rays mark: the rayed version read as the sun
// glyph the theme toggle already uses, two rows below it in the same column.
const SettingsIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.3" />
    <path d="M12.9 9.8a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 1 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67z" />
  </Icon>
);

const NAV = [
  { to: "/", label: "Home", end: true, Glyph: HomeIcon },
  { to: "/apps", label: "Apps", end: false, Glyph: AppsIcon },
  { to: "/agents", label: "Agents", end: false, Glyph: AgentsIcon },
  { to: "/files", label: "Files", end: false, Glyph: FilesIcon },
  { to: "/activity", label: "Activity", end: false, Glyph: ActivityIcon },
];

function itemClass({ isActive }: { isActive: boolean }) {
  return `wb-nav-item${isActive ? " wb-nav-item-active" : ""}`;
}

export function Sidebar() {
  const { user } = useAuth();

  return (
    <nav className="wb-sidebar" aria-label="Main">
      <div className="wb-brand">
        <BrandLockup compact />
      </div>

      <ul className="wb-nav">
        {NAV.map(({ to, label, end, Glyph }) => (
          <li key={to}>
            <NavLink to={to} end={end} className={itemClass}>
              <Glyph />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="wb-sidebar-foot">
        <NavLink to="/settings" className={itemClass}>
          <SettingsIcon />
          Settings
        </NavLink>
        <div className="wb-user">
          <span className="wb-user-email" title={user?.email ?? undefined}>
            {user?.email ?? "Signed in"}
          </span>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
