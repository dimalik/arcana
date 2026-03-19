"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign,
  Zap,
  AlertTriangle,
  Users,
  TrendingUp,
  Activity,
  Package,
  FileDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  totalCalls: number;
  errorCount: number;
  byModel: Record<string, { cost: number; tokens: number; calls: number }>;
  byOperation: Record<
    string,
    { cost: number; tokens: number; calls: number }
  >;
  byDay: { date: string; cost: number; tokens: number; calls: number }[];
}

interface AppEvent {
  id: string;
  level: string;
  category: string;
  message: string;
  metadata: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null } | null;
}

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  _count: { llmUsageLogs: number; appEvents: number };
}

interface BatchInfo {
  id: string;
  groupId: string;
  phase: number;
  status: string;
  requestCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}

interface BatchData {
  summary: {
    processing: number;
    submitted: number;
    completed: number;
    failed: number;
    totalRequests: number;
    completedRequests: number;
    failedRequests: number;
  };
  missingPdfs: {
    repairable: number;
    total: number;
    library: number;
    research: number;
  };
  batches: BatchInfo[];
}

export default function AdminPage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [batchData, setBatchData] = useState<BatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<string | null>(null);

  const fetchBatches = () => {
    fetch("/api/admin/batches").then((r) => r.json()).then(setBatchData).catch(() => {});
  };

  useEffect(() => {
    Promise.all([
      fetch(`/api/admin/usage?days=${days}`).then((r) => r.json()),
      fetch("/api/admin/events?limit=30&level=error").then((r) => r.json()),
      fetch("/api/admin/users").then((r) => r.json()),
      fetch("/api/admin/batches").then((r) => r.json()),
    ])
      .then(([usageData, eventsData, usersData, batchesData]) => {
        setUsage(usageData);
        setEvents(Array.isArray(eventsData) ? eventsData : []);
        setUsers(Array.isArray(usersData) ? usersData : []);
        setBatchData(batchesData);
      })
      .catch(() => toast.error("Failed to load admin data"))
      .finally(() => setLoading(false));
  }, [days]);

  const handleRepairPdfs = async (limit: number, scope: "all" | "library" | "research") => {
    setRepairing(true);
    setRepairResult(null);
    try {
      const res = await fetch(`/api/admin/repair-pdfs?limit=${limit}&scope=${scope}&reprocess=true`, { method: "POST" });
      const data = await res.json();
      setRepairResult(`Downloaded ${data.downloaded}/${data.processed} PDFs, extracted text for ${data.textExtracted}, ${data.queued} queued for batch${data.batch ? ` — ${data.batch}` : ""}`);
      fetchBatches();
    } catch {
      setRepairResult("Repair failed");
    }
    setRepairing(false);
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Admin</h2>
          <p className="text-sm text-muted-foreground">
            Cost tracking, usage analytics, and system health.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                days === d
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      {usage && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <DollarSign className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-2xl font-bold">
                  ${usage.totalCost.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">Total Cost</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Zap className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">
                  {usage.totalCalls.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">LLM Calls</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-purple-500" />
              <div>
                <p className="text-2xl font-bold">
                  {(usage.totalTokens / 1000).toFixed(0)}k
                </p>
                <p className="text-xs text-muted-foreground">Tokens Used</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{usage.errorCount}</p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Model */}
        {usage && Object.keys(usage.byModel).length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-medium mb-3">Cost by Model</h3>
              <div className="space-y-2">
                {Object.entries(usage.byModel)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([model, data]) => (
                    <div key={model} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-xs truncate">
                          {model}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {data.calls} calls
                        </span>
                      </div>
                      <span className="font-medium shrink-0">
                        ${data.cost.toFixed(3)}
                      </span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cost by Operation */}
        {usage && Object.keys(usage.byOperation).length > 0 && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-medium mb-3">Cost by Operation</h3>
              <div className="space-y-2">
                {Object.entries(usage.byOperation)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([op, data]) => (
                    <div key={op} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{op}</span>
                        <span className="text-muted-foreground text-xs">
                          {data.calls} calls
                        </span>
                      </div>
                      <span className="font-medium shrink-0">
                        ${data.cost.toFixed(3)}
                      </span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Daily Usage */}
      {usage && usage.byDay.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-medium mb-3">Daily Usage</h3>
            <div className="space-y-1">
              {usage.byDay.map((day) => {
                const maxCost = Math.max(...usage.byDay.map((d) => d.cost));
                const pct = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
                return (
                  <div key={day.date} className="flex items-center gap-3 text-xs">
                    <span className="w-20 text-muted-foreground font-mono shrink-0">
                      {day.date.slice(5)}
                    </span>
                    <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-16 text-right shrink-0">
                      ${day.cost.toFixed(3)}
                    </span>
                    <span className="w-16 text-right text-muted-foreground shrink-0">
                      {day.calls} calls
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Batch Processing */}
      {batchData && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Package className="h-4 w-4" />
                Batch Processing
              </h3>
              <button onClick={fetchBatches} className="text-muted-foreground hover:text-foreground transition-colors">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Summary pills */}
            <div className="flex flex-wrap gap-2">
              {batchData.summary.processing > 0 && (
                <Badge variant="default" className="text-xs gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {batchData.summary.processing} processing
                </Badge>
              )}
              {batchData.summary.submitted > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {batchData.summary.submitted} submitted
                </Badge>
              )}
              {batchData.summary.completed > 0 && (
                <Badge variant="outline" className="text-xs">
                  {batchData.summary.completed} completed
                </Badge>
              )}
              {batchData.summary.failed > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {batchData.summary.failed} failed
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {batchData.summary.completedRequests}/{batchData.summary.totalRequests} requests done
              </span>
            </div>

            {/* Missing PDFs + repair */}
            {batchData.missingPdfs.total > 0 && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <FileDown className="h-4 w-4 text-amber-500" />
                  <span className="font-medium">{batchData.missingPdfs.repairable} papers missing PDFs</span>
                  <span className="text-xs text-muted-foreground">(repairable — have arXiv/DOI)</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{batchData.missingPdfs.library} in library</span>
                  <span>{batchData.missingPdfs.research} from research</span>
                  {batchData.missingPdfs.total - batchData.missingPdfs.repairable > 0 && (
                    <span>{batchData.missingPdfs.total - batchData.missingPdfs.repairable} unrepairable (no identifier)</span>
                  )}
                </div>
                <div className="space-y-2">
                  {([
                    { scope: "library" as const, label: "Library", count: batchData.missingPdfs.library },
                    { scope: "research" as const, label: "Research", count: batchData.missingPdfs.research },
                  ]).filter((s) => s.count > 0).map(({ scope, label, count }) => (
                    <div key={scope} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-20">{label} ({count})</span>
                      {[50, 200, 500].map((n) => (
                        <Button
                          key={n}
                          size="sm"
                          variant="outline"
                          onClick={() => handleRepairPdfs(n, scope)}
                          disabled={repairing}
                          className="text-xs h-6 px-2"
                        >
                          {n}
                        </Button>
                      ))}
                    </div>
                  ))}
                  {repairing && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Downloading PDFs and extracting text...
                    </div>
                  )}
                </div>
                {repairResult && (
                  <p className="text-xs text-muted-foreground">{repairResult}</p>
                )}
              </div>
            )}

            {/* Recent batches table */}
            {batchData.batches.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground/60 border-b">
                      <th className="text-left py-1.5 font-medium">Group</th>
                      <th className="text-left py-1.5 font-medium">Phase</th>
                      <th className="text-left py-1.5 font-medium">Status</th>
                      <th className="text-right py-1.5 font-medium">Requests</th>
                      <th className="text-right py-1.5 font-medium">Done</th>
                      <th className="text-right py-1.5 font-medium">Failed</th>
                      <th className="text-right py-1.5 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchData.batches.map((b) => (
                      <tr key={b.id} className="border-b border-border/30 hover:bg-muted/30">
                        <td className="py-1.5 font-mono text-muted-foreground">{b.groupId.slice(0, 8)}</td>
                        <td className="py-1.5">{b.phase}</td>
                        <td className="py-1.5">
                          <Badge
                            variant={
                              b.status === "COMPLETED" ? "outline" :
                              b.status === "PROCESSING" ? "default" :
                              b.status === "FAILED" ? "destructive" : "secondary"
                            }
                            className="text-[10px]"
                          >
                            {b.status === "PROCESSING" && <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />}
                            {b.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td className="py-1.5 text-right">{b.requestCount}</td>
                        <td className="py-1.5 text-right">{b.completedCount}</td>
                        <td className="py-1.5 text-right">{b.failedCount || "—"}</td>
                        <td className="py-1.5 text-right text-muted-foreground">
                          {new Date(b.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Users */}
      {users.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Users className="h-4 w-4" />
              Users
            </h3>
            <div className="space-y-2">
              {users.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span>{u.name || u.email}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {u.role}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {u._count.llmUsageLogs} LLM calls
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Errors */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Recent Errors
          </h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors recorded.</p>
          ) : (
            <div className="space-y-2">
              {events.map((evt) => (
                <div
                  key={evt.id}
                  className="text-sm border-l-2 border-red-500/50 pl-3 py-1"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="text-[10px] text-red-600"
                    >
                      {evt.category}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(evt.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs mt-0.5 text-muted-foreground line-clamp-2">
                    {evt.message}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
