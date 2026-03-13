import {
  FileText,
  BookOpen,
  Layers,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const navItems: NavItem[] = [
  { href: "/", label: "Papers", icon: FileText },
  { href: "/research", label: "Research", icon: FlaskConical },
  { href: "/synthesis", label: "Synthesis", icon: Layers },
  { href: "/notebook", label: "Notebook", icon: BookOpen },
];
