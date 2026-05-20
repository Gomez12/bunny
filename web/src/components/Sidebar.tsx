import { useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import Rabbit from "./Rabbit";
import {
  MessageCircle,
  Kanban,
  Clock,
  FileText,
  Palette,
  Folder,
  Users,
  Building2,
  Library,
  Newspaper,
  Code,
  CalendarRange,
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
  Shapes,
  BookOpen,
} from "../lib/icons";
import type { AuthUser, Theme } from "../api";
import NotificationBell from "./NotificationBell";

export type NavTabId =
  | "chat"
  | "board"
  | "workflows"
  | "diary"
  | "tasks"
  | "documents"
  | "whiteboard"
  | "diagrams"
  | "files"
  | "contacts"
  | "businesses"
  | "knowledge-base"
  | "news"
  | "code"
  | "planning"
  | "workspace"
  | "dashboard"
  | "notifications"
  | "settings";

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>;

type NavItem = {
  id: NavTabId;
  icon: IconType;
};

type NavGroupId = "overview" | "work" | "content" | "configure";

type NavGroup = {
  id: NavGroupId;
  items: NavItem[];
};

// Structural list — labels are resolved at render time via the literal
// `t("nav.items.<id>")` / `t("nav.groups.<id>")` calls in the body of
// `Sidebar`. That keeps every key visible to `bun run i18n:check`.
const NAV: NavGroup[] = [
  {
    id: "overview",
    items: [{ id: "dashboard", icon: LayoutDashboard }],
  },
  {
    id: "work",
    items: [
      { id: "chat", icon: MessageCircle },
      { id: "board", icon: Kanban },
      { id: "planning", icon: CalendarRange },
      { id: "workflows", icon: Workflow },
      { id: "diary", icon: BookOpen },
    ],
  },
  {
    id: "content",
    items: [
      { id: "documents", icon: FileText },
      { id: "whiteboard", icon: Palette },
      { id: "diagrams", icon: Shapes },
      { id: "files", icon: Folder },
      { id: "code", icon: Code },
      { id: "contacts", icon: Users },
      { id: "businesses", icon: Building2 },
      { id: "knowledge-base", icon: Library },
      { id: "news", icon: Newspaper },
    ],
  },
  {
    id: "configure",
    items: [{ id: "tasks", icon: Clock }],
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const closeDrawer = () => setOpen(false);

  const isDark = theme === "dark";
  const themeLabel = isDark
    ? t("nav.theme.switchToLight")
    : t("nav.theme.switchToDark");

  // Static lookups keep every i18n key as a literal string so
  // `bun run i18n:check` can verify each one resolves.
  const groupLabel: Record<NavGroupId, string> = {
    overview: t("nav.groups.overview"),
    work: t("nav.groups.work"),
    content: t("nav.groups.content"),
    configure: t("nav.groups.configure"),
  };
  const itemLabel: Record<NavTabId, string> = {
    dashboard: t("nav.items.dashboard"),
    chat: t("nav.items.chat"),
    board: t("nav.items.board"),
    planning: t("nav.items.planning"),
    workflows: t("nav.items.workflows"),
    diary: t("nav.items.diary"),
    documents: t("nav.items.documents"),
    whiteboard: t("nav.items.whiteboard"),
    diagrams: t("nav.items.diagrams"),
    files: t("nav.items.files"),
    code: t("nav.items.code"),
    contacts: t("nav.items.contacts"),
    businesses: t("nav.items.businesses"),
    "knowledge-base": t("nav.items.knowledgeBase"),
    news: t("nav.items.news"),
    tasks: t("nav.items.tasks"),
    // The tabs below have no sidebar entry; they're reached via the user-row
    // gear icon, the notification bell, or the project picker. Provide
    // fallbacks so the map remains exhaustive against NavTabId.
    settings: "",
    notifications: "",
    workspace: "",
  };

  return (
    <>
      <button
        type="button"
        className="nav__drawer-btn"
        aria-label={open ? t("nav.a11y.closeMenu") : t("nav.a11y.openMenu")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={16} /> : <Menu size={16} />}
      </button>
      <nav
        className={`nav ${open ? "nav--open" : ""}`}
        aria-label="Primary"
        onMouseLeave={(e) => {
          const focused = e.currentTarget.querySelector(
            ":focus",
          ) as HTMLElement | null;
          focused?.blur();
        }}
      >
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
            title={t("nav.project.switchTitle")}
          >
            <span className="nav__project-label">{t("nav.project.label")}</span>
            <span className="nav__project-value">{activeProject}</span>
          </button>

          {NAV.map((group) => (
            <div className="nav__group" key={group.id}>
              <div className="nav__group-label">{groupLabel[group.id]}</div>
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
                      <span className="nav__item-label">
                        {itemLabel[item.id]}
                      </span>
                    </button>
                    {item.id === "chat" && (
                      <button
                        type="button"
                        className="nav__item-extra"
                        title={t("nav.a11y.newChatWithAgent")}
                        aria-label={t("nav.a11y.newChatWithAgent")}
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
                title={t("nav.a11y.openSettings")}
                aria-label={t("nav.a11y.openSettings")}
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
            <span>
              {isDark ? t("nav.theme.lightLabel") : t("nav.theme.darkLabel")}
            </span>
          </button>
          <button
            type="button"
            className="nav__logout"
            onClick={onLogout}
            aria-label={t("nav.logout")}
          >
            <LogOut size={14} />
            <span>{t("nav.logout")}</span>
          </button>
        </div>
      </nav>
      {open && <div className="nav__backdrop" onClick={closeDrawer} />}
    </>
  );
}
