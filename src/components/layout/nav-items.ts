import {
  FileText,
  Upload,
  Tags,
  FolderTree,
  LayoutDashboard,
  Settings,
  Download,
  BookOpen,
  Compass,
  Activity,
  Brain,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/papers", label: "Papers", icon: FileText },
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/import", label: "Import", icon: Download },
  { href: "/tags", label: "Tags", icon: Tags },
  { href: "/collections", label: "Collections", icon: FolderTree },
  { href: "/discovery", label: "Discovery", icon: Compass },
  { href: "/mind-palace", label: "Mind Palace", icon: Brain },
  { href: "/notebook", label: "Notebook", icon: BookOpen },
  { href: "/engagement", label: "Engagement", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];
