"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { LogOut, Settings, Shield, User } from "lucide-react";

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export function UserMenu() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !data.error) setUser(data);
      })
      .catch(() => {});
  }, []);

  if (!user) return null;

  const initials = user.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email?.[0]?.toUpperCase() ?? "U";

  const isAdmin = user.role === "admin";

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title={user.name || user.email || "User"}
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            {user.name && (
              <p className="text-sm font-medium">{user.name}</p>
            )}
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <User className="h-4 w-4" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          <Settings className="h-4 w-4" />
          Settings
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onClick={() => router.push("/admin")}>
            <Shield className="h-4 w-4" />
            Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
