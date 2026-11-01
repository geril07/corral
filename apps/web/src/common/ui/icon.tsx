import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
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
  FolderPlus,
  LayoutDashboard,
  Play,
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
  back: ArrowLeft,
  board: LayoutDashboard,
  close: X,
  collapse: ChevronDown,
  config: CircleAlert,
  expand: ChevronRight,
  find: Search,
  more: Ellipsis,
  palette: Command,
  remove: Trash2,
  restart: Play,
  settle: Archive,
  settings: Settings,
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

/** One lucide glyph at the kit's standard size, always hidden from the accessible name. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden className={cn("size-4 shrink-0", className)} />;
}
