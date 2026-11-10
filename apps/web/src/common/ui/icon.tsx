import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleX,
  Circle,
  CircleDot,
  Check,
  Command,
  Ellipsis,
  Folder,
  FolderPlus,
  GitBranch,
  LayoutDashboard,
  MessagesSquare,
  MessageSquareDashed,
  Play,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  SlidersHorizontal,
  Plus,
  Search,
  Settings,
  Square,
  SquarePen,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../lib/cn.ts";

const ICONS = {
  add: Plus,
  "add-project": FolderPlus,
  agent: Bot,
  chat: MessagesSquare,
  back: ArrowLeft,
  down: ArrowDown,
  up: ArrowUp,
  board: LayoutDashboard,
  branch: GitBranch,
  close: X,
  collapse: ChevronDown,
  config: CircleAlert,
  expand: ChevronRight,
  find: Search,
  more: Ellipsis,
  "no-project": MessageSquareDashed,
  palette: Command,
  pin: Pin,
  unpin: PinOff,
  project: Folder,
  remove: Trash2,
  restart: Play,
  settle: Archive,
  settings: Settings,
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
