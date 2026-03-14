import {
  FileText,
  BookOpen,
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
  { href: "/notebook", label: "Notebook", icon: BookOpen },
];
