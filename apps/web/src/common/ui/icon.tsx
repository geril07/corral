import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleX,
  Circle,
  CircleDot,
  Check,
  Command,
  Copy,
  Ellipsis,
  FileText,
  Folder,
  FolderPlus,
  GitBranch,
  Hash,
  Keyboard,
  LayoutDashboard,
  MessagesSquare,
  MessageSquareDashed,
  Palette,
  Play,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  SlidersHorizontal,
  Sparkles,
  Plus,
  Search,
  Settings,
  Square,
  SquarePen,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "../lib/cn.ts";

const ICONS = {
  add: Plus,
  "add-project": FolderPlus,
  agent: Bot,
  appearance: Palette,
  chat: MessagesSquare,
  back: ArrowLeft,
  defaults: SlidersHorizontal,
  diagnostics: Wrench,
  down: ArrowDown,
  up: ArrowUp,
  board: LayoutDashboard,
  branch: GitBranch,
  close: X,
  collapse: ChevronDown,
  config: CircleAlert,
  copy: Copy,
  expand: ChevronRight,
  find: Search,
  folder: Folder,
  hash: Hash,
  keyboard: Keyboard,
  models: Boxes,
  more: Ellipsis,
  "no-project": MessageSquareDashed,
  naming: Sparkles,
  palette: Command,
  pin: Pin,
  unpin: PinOff,
  profiles: UserRound,
  project: Folder,
  remove: Trash2,
  reset: Undo2,
  restart: Play,
  settle: Archive,
  settings: Settings,
  source: FileText,
  "hide-sidebar": PanelLeftClose,
  "show-sidebar": PanelLeftOpen,
  grouping: SlidersHorizontal,
  stop: Square,
  task: SquarePen,
  terminal: SquareTerminal,
  unsettle: ArchiveRestore,
  warn: TriangleAlert,
  "status-blocked": TriangleAlert,
  "status-error": CircleX,
  "status-working": CircleDot,
  "status-done": Check,
  "status-idle": Circle,
};

export type IconName = keyof typeof ICONS;

/** `row` is the 12 px glyph of sidebar rows, `chrome` the 14 px one of tabs and the task header. */
export type IconSize = "default" | "row" | "chrome";

const SIZES: Readonly<Record<IconSize, string>> = {
  default: "size-4",
  row: "size-3",
  chrome: "size-3.5",
};

/** One lucide glyph at the kit's size step, always hidden from the accessible name. */
export function Icon({
  name,
  size = "default",
  className,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
}) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden className={cn("shrink-0", SIZES[size], className)} />;
}
