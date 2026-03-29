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
  Save,
  FlaskConical,
  Eye,
  EyeOff,
  X,
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
  envVars: string | null;
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
  const [testingEnv, setTestingEnv] = useState<string | null>(null);
  const [envTestResults, setEnvTestResults] = useState<Record<string, { ok: boolean; output?: string; error?: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [pendingEdits, setPendingEdits] = useState<Record<string, Record<string, string>>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const [sshHosts, setSSHHosts] = useState<SSHConfigEntry[]>([]);
  const [expandedHost, setExpandedHost] = useState<string | null>(null);
  const [visibleEnvKeys, setVisibleEnvKeys] = useState<Record<string, Set<number>>>({});

  // Env vars helpers
  const parseEnvVars = (jsonStr: string | null): Array<{ key: string; value: string }> => {
    if (!jsonStr) return [];
    try {
      const obj = JSON.parse(jsonStr);
      return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
    } catch {
      return [];
    }
  };

  const getEnvVarsForHost = (host: RemoteHost): Array<{ key: string; value: string }> => {
    // If there are pending edits for envVars, use those
    const pending = pendingEdits[host.id]?.envVars;
    if (pending !== undefined) return parseEnvVars(pending);
    return parseEnvVars(host.envVars);
  };

  const setEnvVarsForHost = (hostId: string, vars: Array<{ key: string; value: string }>) => {
    const obj: Record<string, string> = {};
    for (const { key, value } of vars) {
      if (key.trim()) obj[key.trim()] = value;
    }
    setPendingEdit(hostId, "envVars", JSON.stringify(obj));
  };

  const toggleEnvValueVisibility = (hostId: string, index: number) => {
    setVisibleEnvKeys((prev) => {
      const hostSet = new Set(prev[hostId] || []);
      if (hostSet.has(index)) hostSet.delete(index);
      else hostSet.add(index);
      return { ...prev, [hostId]: hostSet };
    });
  };

  const isEnvValueVisible = (hostId: string, index: number) => {
    return visibleEnvKeys[hostId]?.has(index) ?? false;
  };

  const ENV_PRESETS = ["HF_TOKEN", "WANDB_API_KEY", "HUGGING_FACE_HUB_TOKEN"];

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

  const setPendingEdit = (hostId: string, field: string, value: string) => {
    setPendingEdits((prev) => ({ ...prev, [hostId]: { ...prev[hostId], [field]: value } }));
  };

  const handleSaveAll = async (id: string) => {
    const edits = pendingEdits[id];
    if (!edits || Object.keys(edits).length === 0) {
      toast.success("No changes to save");
      return;
    }
    setSaving(id);
    try {
      const body: Record<string, string | null> = {};
      for (const [key, val] of Object.entries(edits)) {
        body[key] = val || null;
      }
      await fetch(`/api/research/remote-hosts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setPendingEdits((prev) => { const next = { ...prev }; delete next[id]; return next; });
      fetchHosts();
      toast.success("Changes saved");
    } catch {
      toast.error("Failed to save changes");
    } finally {
      setSaving(null);
    }
  };

  const handleTestEnv = async (id: string) => {
    setTestingEnv(id);
    setEnvTestResults((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      // Save pending edits first so the test uses latest baseRequirements
      if (pendingEdits[id]) await handleSaveAll(id);

      const res = await fetch(`/api/research/remote-hosts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testEnv: true }),
      });
      const data = await res.json();
      setEnvTestResults((prev) => ({ ...prev, [id]: data }));
      if (data.ok) {
        toast.success(data.autoPopulated ? "Environment detected — base requirements auto-populated" : "Environment test passed");
        fetchHosts(); // Refresh to show auto-populated base requirements
      } else {
        toast.error("Environment test failed");
      }
    } catch {
      setEnvTestResults((prev) => ({ ...prev, [id]: { ok: false, error: "Request failed" } }));
      toast.error("Environment test failed");
    } finally {
      setTestingEnv(null);
    }
  };

  const handleProbeEnvNotes = async (id: string) => {
    setProbing(id);
    try {
      const res = await fetch(`/api/research/remote-hosts/${id}/probe-env`);
      const data = await res.json();
      if (data.ok && data.notes) {
        setPendingEdit(id, "envNotes", data.notes);
        // Also update the textarea visually
        const textarea = document.querySelector(`textarea[data-env-notes="${id}"]`) as HTMLTextAreaElement;
        if (textarea) textarea.value = data.notes;
        toast.success("Environment notes generated");
      } else {
        toast.error(data.error || "Failed to probe environment");
      }
    } catch {
      toast.error("Failed to probe environment");
    } finally {
      setProbing(null);
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
                  <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-3">
                    {/* Connection settings */}
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
                        <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Python / Conda Env</label>
                        <input
                          defaultValue={h.conda || ""}
                          onBlur={(e) => handleUpdateField(h.id, "conda", e.target.value)}
                          placeholder="/opt/venv/bin/python or conda env name"
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

                    {/* Action bar — prominent, right after connection settings */}
                    <div className="flex items-center gap-2 py-2 border-y border-border/30">
                      <button
                        onClick={() => handleProbeEnvNotes(h.id)}
                        disabled={probing === h.id}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
                      >
                        {probing === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cpu className="h-3 w-3" />}
                        {probing === h.id ? "Detecting..." : "Detect Environment"}
                      </button>
                      <button
                        onClick={() => handleTestEnv(h.id)}
                        disabled={testingEnv === h.id}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors disabled:opacity-50"
                      >
                        {testingEnv === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                        {testingEnv === h.id ? "Testing..." : "Test Packages"}
                      </button>
                      <div className="flex-1" />
                      <button
                        onClick={() => handleSaveAll(h.id)}
                        disabled={saving === h.id || !pendingEdits[h.id]}
                        className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-[11px] font-medium hover:bg-foreground/90 transition-colors disabled:opacity-30"
                      >
                        {saving === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Save
                      </button>
                      {envTestResults[h.id] && (
                        <span className={`text-[10px] ${envTestResults[h.id].ok ? "text-emerald-500" : "text-destructive"}`}>
                          {envTestResults[h.id].ok ? "Passed" : envTestResults[h.id].error || "Failed"}
                        </span>
                      )}
                    </div>

                    {/* Test output */}
                    {envTestResults[h.id]?.output && (
                      <pre className="text-[10px] text-muted-foreground/60 bg-muted/30 rounded p-2 max-h-32 overflow-auto font-mono whitespace-pre-wrap">
                        {envTestResults[h.id].output}
                      </pre>
                    )}

                    {/* Base Requirements — auto-populated by Detect Environment */}
                    <div className="space-y-1">
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Base Requirements</label>
                      <textarea
                        defaultValue={h.baseRequirements || ""}
                        onChange={(e) => setPendingEdit(h.id, "baseRequirements", e.target.value)}
                        placeholder={"Click 'Detect Environment' above to auto-populate, or add manually:\ntorch==2.3.1\ntransformers>=4.40\naccelerate"}
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] font-mono placeholder:text-muted-foreground/25 focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[80px]"
                        rows={5}
                      />
                      <p className="text-[10px] text-muted-foreground/50">
                        Auto-merged into every project. Agent cannot override these versions.
                      </p>
                    </div>

                    {/* Environment Notes — auto-populated by Detect Environment */}
                    <div className="space-y-1">
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Environment Notes</label>
                      <textarea
                        data-env-notes={h.id}
                        defaultValue={h.envNotes || ""}
                        onChange={(e) => setPendingEdit(h.id, "envNotes", e.target.value)}
                        placeholder="Click 'Detect Environment' above to auto-populate with OS, GPU, CUDA, packages..."
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground/25 focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                        rows={6}
                      />
                      <p className="text-[10px] text-muted-foreground/50">
                        Shown to the research agent. Includes hardware, packages, and quirks.
                      </p>
                    </div>

                    {/* Environment Variables — key-value editor */}
                    <div className="space-y-1.5">
                      <label className="text-[9px] text-muted-foreground uppercase tracking-wide">Environment Variables</label>
                      {(() => {
                        const vars = getEnvVarsForHost(h);
                        return (
                          <div className="space-y-1.5">
                            {vars.map((v, i) => (
                              <div key={i} className="flex items-center gap-1.5">
                                <input
                                  value={v.key}
                                  onChange={(e) => {
                                    const next = [...vars];
                                    next[i] = { ...next[i], key: e.target.value };
                                    setEnvVarsForHost(h.id, next);
                                  }}
                                  placeholder="KEY"
                                  className="w-[140px] rounded border border-input bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                                <div className="relative flex-1">
                                  <input
                                    type={isEnvValueVisible(h.id, i) ? "text" : "password"}
                                    value={v.value}
                                    onChange={(e) => {
                                      const next = [...vars];
                                      next[i] = { ...next[i], value: e.target.value };
                                      setEnvVarsForHost(h.id, next);
                                    }}
                                    placeholder="value"
                                    className="w-full rounded border border-input bg-background px-2 py-1 pr-7 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => toggleEnvValueVisibility(h.id, i)}
                                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                                    title={isEnvValueVisible(h.id, i) ? "Hide value" : "Show value"}
                                  >
                                    {isEnvValueVisible(h.id, i) ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = vars.filter((_, j) => j !== i);
                                    setEnvVarsForHost(h.id, next);
                                  }}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-accent transition-colors shrink-0"
                                  title="Remove variable"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}

                            <div className="flex items-center gap-1.5 flex-wrap">
                              <button
                                type="button"
                                onClick={() => setEnvVarsForHost(h.id, [...vars, { key: "", value: "" }])}
                                className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/60 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                              >
                                <Plus className="h-3 w-3" />
                                Add Variable
                              </button>
                              {ENV_PRESETS.filter((p) => !vars.some((v) => v.key === p)).map((preset) => (
                                <button
                                  key={preset}
                                  type="button"
                                  onClick={() => setEnvVarsForHost(h.id, [...vars, { key: preset, value: "" }])}
                                  className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                >
                                  + {preset}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                      <p className="text-[10px] text-muted-foreground/50">
                        Injected into every remote job. Values are stored locally and never sent to LLMs.
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
