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
  Building2,
  Package,
  Library,
  Newspaper,
  Code,
  GitBranch,
  FolderGit2,
  Workflow,
  Network,
  Terminal,
  MessageSquareMore,
  LayoutDashboard,
  Settings,
  Shapes,
  CalendarRange,
  CalendarClock,
  Tag,
  Tags,
  Target,
  GitPullRequestArrow,
  Lightbulb,
  Flag,
  ListChecks,

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
  ChevronLeft,
  ChevronDown,
  Play,
  Square,
  Pause,
  RefreshCw,
  RotateCcw,
  History,
  HardDrive,
  Eraser,
  ExternalLink,
  ArrowLeft,
  ArrowRight,

  // Visibility
  Eye,
  EyeOff,
  ZoomIn,
  ZoomOut,

  // Status
  AlertCircle,
  AtSign,
  Bell,
  BellRing,
  Info,
  CheckCircle,
  Loader2,

  // Diary / audio
  BookOpen,
  Mic,
  MicOff,
  AudioLines,

  // Domain
  Lock,
  KeyRound,
  ShieldAlert,
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
  Rss,
  ThumbsUp,
  ThumbsDown,

  // Diagram node types
  Router,
  Shield,
  Server,
  Monitor,
  Database,
  Cloud,
  Printer,
  Wifi,
  Shuffle,
  Timer,
  Briefcase,
  Crown,
  Cpu,
  Layers,
  Zap,
  ListOrdered,
  Smartphone,
  Brain,
  Box,
  List,
  Mail,
  StickyNote,
  Table2,
} from "lucide-react";

/**
 * Default icon props. Spread onto any icon to get the sanctioned defaults.
 */
export const ICON_DEFAULTS = {
  size: 18,
  strokeWidth: 1.75,
} as const;
