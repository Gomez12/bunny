/**
 * Icon barrel. Import icons from here, never directly from `lucide-react`.
 *
 * Conventions (see docs/styleguide.md §5):
 * - Source: lucide-react only.
 * - Size: 18 px default, 16 px inline in text, 20 px in the brand lockup.
 * - Stroke-width: 1.75.
 * - Color: currentColor — do not hard-code fills.
 *
 * Add new icons to this file before using them in a component. New icons that
 * do not pass through this barrel will fail review.
 */

export {
  // Navigation
  MessageCircle,
  Kanban,
  Clock,
  FileText,
  Palette,
  Folder,
  Users,
  Package,
  Library,
  Newspaper,
  Code,
  GitBranch,
  FolderGit2,
  LayoutDashboard,
  Settings,

  // Actions
  Plus,
  Search,
  Pencil,
  Trash2,
  Download,
  Upload,
  Copy,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Play,
  Pause,
  RefreshCw,
  RotateCcw,
  Eraser,
  ExternalLink,

  // Visibility
  Eye,
  EyeOff,

  // Status
  AlertCircle,
  AtSign,
  Bell,
  BellRing,
  Info,
  CheckCircle,
  Loader2,

  // Domain
  Lock,
  User,
  Bot,
  Sparkles,
  LogOut,
  Menu,
  Globe,
  Languages,
  Sun,
  Moon,
  Send,
  Link as LinkIcon,
} from "lucide-react";

/**
 * Default icon props. Spread onto any icon to get the sanctioned defaults.
 */
export const ICON_DEFAULTS = {
  size: 18,
  strokeWidth: 1.75,
} as const;
