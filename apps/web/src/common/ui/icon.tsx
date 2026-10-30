import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  Ellipsis,
  FolderPlus,
  LayoutDashboard,
  Play,
  Search,
  Square,
  SquarePen,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../lib/cn.ts";

const ICONS = {
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
  stop: Square,
  task: SquarePen,
  terminal: SquareTerminal,
  unsettle: ArchiveRestore,
  warn: TriangleAlert,
};

export type IconName = keyof typeof ICONS;

/** One lucide glyph at the kit's 14px-in-16px size, always hidden from the accessible name. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden className={cn("size-3.5 shrink-0", className)} strokeWidth={1.75} />;
}
