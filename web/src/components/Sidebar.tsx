import { useState, type ComponentType } from "react";
import Rabbit from "./Rabbit";
import {
  MessageCircle,
  Kanban,
  Clock,
  FileText,
  Palette,
  Folder,
  Users,
  Library,
  Newspaper,
  Code,
  Workflow,
  LayoutDashboard,
  Settings,
  LogOut,
  ICON_DEFAULTS,
  Menu,
  X,
  Sun,
  Moon,
  Plus,
} from "../lib/icons";
import type { AuthUser, Theme } from "../api";
import NotificationBell from "./NotificationBell";

export type NavTabId =
  | "chat"
  | "board"
  | "workflows"
  | "tasks"
  | "documents"
  | "whiteboard"
  | "files"
  | "contacts"
  | "knowledge-base"
  | "news"
  | "code"
  | "workspace"
  | "dashboard"
  | "notifications"
  | "settings";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

type NavItem = {
  id: NavTabId;
  label: string;
  icon: IconType;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ id: "dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Work",
    items: [
      { id: "chat", label: "Chat", icon: MessageCircle },
      { id: "board", label: "Board", icon: Kanban },
      { id: "workflows", label: "Workflows", icon: Workflow },
    ],
  },
  {
    label: "Content",
    items: [
      { id: "documents", label: "Documents", icon: FileText },
      { id: "whiteboard", label: "Whiteboard", icon: Palette },
      { id: "files", label: "Files", icon: Folder },
      { id: "code", label: "Code", icon: Code },
      { id: "contacts", label: "Contacts", icon: Users },
      { id: "knowledge-base", label: "Knowledge Base", icon: Library },
      { id: "news", label: "News", icon: Newspaper },
    ],
  },
  {
    label: "Configure",
    items: [{ id: "tasks", label: "Tasks", icon: Clock }],
  },
];

export interface SidebarNotificationsProps {
  unreadCount: number;
  isActive: boolean;
  onOpen: () => void;
  onRequestPermission: () => void;
}

type Props = {
  activeTab: NavTabId;
  onPickTab: (id: NavTabId) => void;
  user: AuthUser;
  activeProject: string;
  onPickProjectTab: () => void;
  onLogout: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  notifications: SidebarNotificationsProps;
  /** Open the "New chat with…" modal — starts a fresh session bound to a
   *  chosen agent. */
  onNewChatWithAgent: () => void;
};

export default function Sidebar({
  activeTab,
  onPickTab,
  user,
  activeProject,
  onPickProjectTab,
  onLogout,
  theme,
  onToggleTheme,
  notifications,
  onNewChatWithAgent,
}: Props) {
  const [open, setOpen] = useState(false);
  const closeDrawer = () => setOpen(false);

  const isDark = theme === "dark";
  const themeLabel = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <>
      <button
        type="button"
        className="nav__drawer-btn"
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={16} /> : <Menu size={16} />}
      </button>
      <nav className={`nav ${open ? "nav--open" : ""}`} aria-label="Primary">
        <div className="nav__brand">
          <span className="nav__brand-rabbit">
            <Rabbit size={20} />
          </span>
          <span className="nav__brand-text">bunny</span>
        </div>

        <div className="nav__groups">
          <button
            type="button"
            className="nav__project"
            onClick={() => {
              onPickProjectTab();
              closeDrawer();
            }}
            title="Switch project"
          >
            <span className="nav__project-label">Project</span>
            <span className="nav__project-value">{activeProject}</span>
          </button>

          {NAV.map((group) => (
            <div className="nav__group" key={group.label}>
              <div className="nav__group-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <div key={item.id} className="nav__item-row">
                    <button
                      type="button"
                      className={`nav__item ${isActive ? "nav__item--active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => {
                        onPickTab(item.id);
                        closeDrawer();
                      }}
                    >
                      <span className="nav__item-icon">
                        <Icon {...ICON_DEFAULTS} />
                      </span>
                      <span className="nav__item-label">{item.label}</span>
                    </button>
                    {item.id === "chat" && (
                      <button
                        type="button"
                        className="nav__item-extra"
                        title="New chat with…"
                        aria-label="New chat with…"
                        onClick={() => {
                          onNewChatWithAgent();
                          closeDrawer();
                        }}
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="nav__footer">
          <div className="nav__user-row">
            <NotificationBell
              unreadCount={notifications.unreadCount}
              isActive={notifications.isActive}
              onOpen={() => {
                notifications.onOpen();
                closeDrawer();
              }}
              onRequestPermission={notifications.onRequestPermission}
            />
            <div className="nav__user" title={user.email ?? ""}>
              <span className="nav__user-name">
                {user.displayName || user.username}
              </span>
              <span className="nav__user-role">{user.role}</span>
              <button
                type="button"
                className="nav__user-settings"
                onClick={() => {
                  onPickTab("settings");
                  closeDrawer();
                }}
                title="Open settings"
                aria-label="Open settings"
              >
                <Settings size={14} />
              </button>
            </div>
          </div>
          <button
            type="button"
            className="nav__theme"
            onClick={onToggleTheme}
            title={themeLabel}
            aria-label={themeLabel}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
            <span>{isDark ? "Light mode" : "Dark mode"}</span>
          </button>
          <button type="button" className="nav__logout" onClick={onLogout} aria-label="Logout">
            <LogOut size={14} />
            <span>Logout</span>
          </button>
        </div>
      </nav>
      {open && <div className="nav__backdrop" onClick={closeDrawer} />}
    </>
  );
}
