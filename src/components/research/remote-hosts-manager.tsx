"use client";

import { useEffect, useState, useRef } from "react";
import {
  Server,
  Plus,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  Star,
  Wifi,
  Cpu,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

interface RemoteHost {
  id: string;
  alias: string;
  backend: string;
  host: string;
  port: number;
  user: string;
  keyPath: string | null;
  workDir: string;
  gpuType: string | null;
  conda: string | null;
  setupCmd: string | null;
  baseRequirements: string | null;
  envNotes: string | null;
  isDefault: boolean;
  _count: { jobs: number };
}

interface SSHConfigEntry {
  host: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyCommand: string | null;
}

interface TestResult {
  ok: boolean;
  error?: string;
  gpuInfo?: string;
  hostname?: string;
  user?: string;
}

export function RemoteHostsManager() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [sshHosts, setSSHHosts] = useState<SSHConfigEntry[]>([]);
  const [expandedHost, setExpandedHost] = useState<string | null>(null);

  // Add form
  const [hostInput, setHostInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [aliasInput, setAliasInput] = useState("");
  const [workDirInput, setWorkDirInput] = useState("~/experiments");
  const [condaInput, setCondaInput] = useState("");
  const [setupCmdInput, setSetupCmdInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchHosts = () => {
    fetch("/api/research/remote-hosts")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setHosts(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchHosts(); }, []);

  // Load SSH config hosts for autocomplete
  useEffect(() => {
    fetch("/api/research/remote-hosts/ssh-config")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setSSHHosts(data); })
      .catch(() => {});
  }, []);

  // Filter suggestions
  const existingAliases = new Set(hosts.map((h) => h.host));
  const suggestions = hostInput.length > 0
    ? sshHosts.filter((s) =>
        s.host.toLowerCase().includes(hostInput.toLowerCase()) &&
        !existingAliases.has(s.host)
      )
    : [];

  const handleSelectSSHHost = (entry: SSHConfigEntry) => {
    setHostInput(entry.host);
    setAliasInput(entry.host); // default alias = host alias
    setShowSuggestions(false);
  };

  const handleAdd = async () => {
    const host = hostInput.trim();
    if (!host) {
      toast.error("Enter a hostname or SSH config alias");
      return;
    }

    const alias = aliasInput.trim() || host;
    const sshEntry = sshHosts.find((s) => s.host === host);

    try {
      const res = await fetch("/api/research/remote-hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias,
          host,
          // If it's an SSH config entry, let SSH handle user/port/key
          user: sshEntry?.user || "-",
          port: sshEntry?.port || 22,
          keyPath: sshEntry?.identityFile || null,
          workDir: workDirInput || "~/experiments",
          conda: condaInput || null,
          setupCmd: setupCmdInput || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      const newHost = await res.json();
      toast.success("Host added — testing connection...");
      setAdding(false);
      setHostInput("");
      setAliasInput("");
      setCondaInput("");
      setSetupCmdInput("");
      fetchHosts();

      // Auto-test connection
      handleTest(newHost.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add host");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/research/remote-hosts/${id}`, { method: "DELETE" });
      setHosts((prev) => prev.filter((h) => h.id !== id));
      toast.success("Host removed");
    } catch {
      toast.error("Failed to delete host");
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResults((prev) => ({ ...prev, [id]: { ok: false } }));
    try {
      const res = await fetch(`/api/research/remote-hosts/${id}`, { method: "POST" });
      const data: TestResult = await res.json();
      setTestResults((prev) => ({ ...prev, [id]: data }));
      if (data.ok) {
        const gpuMsg = data.gpuInfo ? ` — ${data.gpuInfo}` : "";
        toast.success(`Connected${gpuMsg}`);
        // Refresh to pick up auto-detected GPU type
        fetchHosts();
      } else {
        toast.error(`Connection failed: ${data.error}`);
      }
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: "Request failed" } }));
      toast.error("Connection test failed");
    } finally {
      setTesting(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await fetch(`/api/research/remote-hosts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      fetchHosts();
    } catch {
      toast.error("Failed to set default");
    }
  };

  const handleUpdateField = async (id: string, field: string, value: string) => {
    try {
      await fetch(`/api/research/remote-hosts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value || null }),
      });
      fetchHosts();
    } catch {
      toast.error("Failed to update");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Remote Hosts</span>
          {sshHosts.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {sshHosts.length} in SSH config
            </span>
          )}
        </div>
        <button
          onClick={() => { setAdding(!adding); setTimeout(() => inputRef.current?.focus(), 50); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Add form — simplified: just type hostname */}
      {adding && (
        <Card>
          <CardContent className="py-3 space-y-2">
            <div className="relative">
              <input
                ref={inputRef}
                value={hostInput}
                onChange={(e) => { setHostInput(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                placeholder="Hostname or SSH config alias (e.g. lab-a100)"
                className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") setAdding(false);
                }}
              />

              {/* SSH config autocomplete dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-md max-h-48 overflow-auto">
                  {suggestions.map((entry) => (
                    <button
                      key={entry.host}
                      onMouseDown={(e) => { e.preventDefault(); handleSelectSSHHost(entry); }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-accent text-left transition-colors"
                    >
                      <Server className="h-3 w-3 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium">{entry.host}</span>
                        <span className="text-[10px] text-muted-foreground ml-2">
                          {entry.user && entry.user !== "-" ? `${entry.user}@` : ""}
                          {entry.hostName || ""}
                          {entry.proxyCommand ? " (proxy)" : ""}
                        </span>
                      </div>
                      <span className="text-[9px] text-muted-foreground/50">SSH config</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Optional fields (collapsed by default) */}
            <div className="grid grid-cols-2 gap-2">
              <input
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                placeholder={`Alias (default: ${hostInput || "hostname"})`}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                value={workDirInput}
                onChange={(e) => setWorkDirInput(e.target.value)}
                placeholder="Work dir (~/experiments)"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={condaInput}
                onChange={(e) => setCondaInput(e.target.value)}
                placeholder="Conda env (optional)"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                value={setupCmdInput}
                onChange={(e) => setSetupCmdInput(e.target.value)}
                placeholder="Setup cmd (optional)"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="flex gap-1.5">
              <button
                onClick={handleAdd}
                disabled={!hostInput.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[11px] hover:bg-primary/90 disabled:opacity-50"
              >
                Add & Test
              </button>
              <button
                onClick={() => setAdding(false)}
                className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1.5"
              >
                Cancel
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Host list */}
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading...</div>
      ) : hosts.length === 0 && !adding ? (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground text-xs">
            No remote hosts configured. Add one to run experiments on GPU machines.
            {sshHosts.length > 0 && (
              <span className="block mt-1 text-[10px]">
                {sshHosts.length} hosts found in your SSH config — click + to add one.
              </span>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {hosts.map((h) => {
            const result = testResults[h.id];
            const isExpanded = expandedHost === h.id;

            return (
              <div key={h.id} className="rounded-md border border-border">
                {/* Main row */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => setExpandedHost(isExpanded ? null : h.id)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3 w-3" />
                      : <ChevronRight className="h-3 w-3" />
                    }
                  </button>

                  <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium">{h.alias}</span>
                      {h.isDefault && <Star className="h-3 w-3 text-amber-500 fill-amber-500" />}
                      {h.gpuType && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                          <Cpu className="h-2.5 w-2.5" />
                          {h.gpuType}
                        </span>
                      )}
                      {result?.ok === true && <CheckCircle className="h-3 w-3 text-emerald-500" />}
                      {result?.ok === false && result?.error && <XCircle className="h-3 w-3 text-red-500" />}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {h.user !== "-" ? `${h.user}@` : ""}{h.host}
                      {h.conda && ` (${h.conda})`}
                      {result?.ok && result?.hostname && ` — ${result.hostname}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => handleTest(h.id)}
                      disabled={testing === h.id}
                      className="inline-flex h-6 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent px-1.5 transition-colors text-[10px]"
                      title="Test connection"
                    >
                      {testing === h.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wifi className="h-3 w-3" />
                      )}
                      Test
                    </button>
                    {!h.isDefault && (
                      <button
                        onClick={() => handleSetDefault(h.id)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-amber-500 hover:bg-accent transition-colors"
                        title="Set as default"
                      >
                        <Star className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(h.id)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Test result details */}
                {result?.ok === false && result?.error && (
                  <div className="px-3 pb-2">
                    <p className="text-[10px] text-destructive bg-destructive/5 rounded px-2 py-1">
                      {result.error}
                    </p>
                  </div>
                )}

                {result?.ok && result?.gpuInfo && !isExpanded && (
                  <div className="px-3 pb-2">
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                      <Cpu className="h-2.5 w-2.5 inline mr-0.5" />
                      {result.gpuInfo}
                    </p>
                  </div>
                )}

                {/* Expanded config */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Work Dir</label>
                        <input
                          defaultValue={h.workDir}
                          onBlur={(e) => handleUpdateField(h.id, "workDir", e.target.value)}
                          className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Conda Env</label>
                        <input
                          defaultValue={h.conda || ""}
                          onBlur={(e) => handleUpdateField(h.id, "conda", e.target.value)}
                          placeholder="none"
                          className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Setup Command</label>
                      <input
                        defaultValue={h.setupCmd || ""}
                        onBlur={(e) => handleUpdateField(h.id, "setupCmd", e.target.value)}
                        placeholder="e.g. module load cuda/12.1"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Base Requirements</label>
                      <textarea
                        defaultValue={h.baseRequirements || ""}
                        onBlur={(e) => handleUpdateField(h.id, "baseRequirements", e.target.value)}
                        placeholder={"# Tested base packages (one per line)\ntorch==2.3.1\ntransformers>=4.40\naccelerate\ndatasets"}
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] font-mono placeholder:text-muted-foreground/25 focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[100px]"
                        rows={6}
                      />
                      <p className="text-[10px] text-muted-foreground/50">
                        Packages here are auto-merged into every project&apos;s requirements.txt. Test them manually first.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Environment Notes</label>
                      <textarea
                        defaultValue={h.envNotes || ""}
                        onBlur={(e) => handleUpdateField(h.id, "envNotes", e.target.value)}
                        placeholder="e.g., flash-attn works with CUDA 12.1, use fp16 not bf16, conda activate myenv first"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground/25 focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                        rows={3}
                      />
                      <p className="text-[10px] text-muted-foreground/50">
                        Free-text notes shown to the research agent. Include any quirks or gotchas.
                      </p>
                    </div>
                    {h._count.jobs > 0 && (
                      <p className="text-[10px] text-muted-foreground">{h._count.jobs} job{h._count.jobs !== 1 ? "s" : ""} run on this host</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
