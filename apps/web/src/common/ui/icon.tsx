import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  Boxes,
  Brain,
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
  Eye,
  File,
  FileText,
  Folder,
  FolderPlus,
  GitBranch,
  Hammer,
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
  Quote,
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
  WifiOff,
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
  connection: WifiOff,
  copy: Copy,
  expand: ChevronRight,
  // The chat transcript's activity glyphs: T3 gives its work rows one per action (`presentation.ts`,
  // `toolGroupActionLabel`): eye for a read, square-pen for an edit, terminal for a command,
  // search for code search, wrench for anything else, hammer for a mixed group, brain for thinking.
  edit: SquarePen,
  file: File,
  find: Search,
  folder: Folder,
  hammer: Hammer,
  hash: Hash,
  keyboard: Keyboard,
  models: Boxes,
  more: Ellipsis,
  "no-project": MessageSquareDashed,
  naming: Sparkles,
  palette: Command,
  pin: Pin,
  quote: Quote,
  read: Eye,
  thinking: Brain,
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

/**
 * The one disclosure chevron: it points right when the row is closed and turns a quarter turn
 * when it opens, over the kit's one 200 ms motion, and does not move under reduced motion. T3
 * rotates a single chevron the same way (`MessagesTimeline.tsx:1660-1668`) rather than swapping two
 * glyphs, so the two states share one shape.
 */
export function DisclosureIcon({ open, size = "row" }: { open: boolean; size?: IconSize }) {
  return (
    <Icon
      name="expand"
      size={size}
      className={cn(
        "transition-transform duration-200 motion-reduce:transition-none",
        open && "rotate-90",
      )}
    />
  );
}
