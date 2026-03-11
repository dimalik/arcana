"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  RefreshCw,
  Save,
  Check,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { TagPicker } from "@/components/tags/tag-picker";

interface Tag {
  id: string;
  name: string;
  color: string;
  score?: number;
}

interface MetadataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperId: string;
  initial: {
    title: string;
    abstract: string;
    authors: string;
    year: string;
    venue: string;
    doi: string;
  };
  tags: Tag[];
  onSaved: () => void;
}

interface FetchedField {
  field: string;
  oldValue: string;
  newValue: string;
  accepted: boolean;
}

export function MetadataDialog({
  open,
  onOpenChange,
  paperId,
  initial,
  tags,
  onSaved,
}: MetadataDialogProps) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchedFields, setFetchedFields] = useState<FetchedField[]>([]);
  const [fetchSource, setFetchSource] = useState<string | null>(null);

  // Sync form with initial when dialog opens
  useEffect(() => {
    if (open) {
      setForm(initial);
      setFetchedFields([]);
      setFetchSource(null);
    }
  }, [open, initial]);

  const handleRefetch = async () => {
    setFetching(true);
    setFetchedFields([]);
    setFetchSource(null);
    try {
      const res = await fetch(`/api/papers/${paperId}/refetch-metadata`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "No metadata found");
        return;
      }
      const data = await res.json();
      setFetchSource(data.source);

      // Re-fetch the paper to get the updated values
      const paperRes = await fetch(`/api/papers/${paperId}`);
      if (!paperRes.ok) return;
      const paper = await paperRes.json();

      const fields: FetchedField[] = [];
      const fieldMap: Record<string, { key: keyof typeof form; format?: (v: unknown) => string }> = {
        abstract: { key: "abstract" },
        authors: { key: "authors", format: (v) => { try { return JSON.parse(v as string).join(", "); } catch { return v as string; } } },
        year: { key: "year", format: (v) => String(v ?? "") },
        venue: { key: "venue" },
        doi: { key: "doi" },
      };

      for (const updatedField of data.updated as string[]) {
        const mapping = fieldMap[updatedField];
        if (!mapping) continue;
        const rawValue = paper[updatedField];
        const newValue = mapping.format ? mapping.format(rawValue) : (rawValue ?? "");
        const oldValue = form[mapping.key];
        if (newValue && newValue !== oldValue) {
          fields.push({
            field: updatedField,
            oldValue,
            newValue,
            accepted: true,
          });
        }
      }

      if (fields.length === 0) {
        toast.info("No new metadata found");
      } else {
        // Auto-apply accepted fields to the form
        const newForm = { ...form };
        for (const f of fields) {
          const mapping = fieldMap[f.field];
          if (mapping && f.accepted) {
            newForm[mapping.key] = f.newValue;
          }
        }
        setForm(newForm);
        setFetchedFields(fields);
        toast.success(`Found ${fields.length} updated field${fields.length > 1 ? "s" : ""} from ${data.source}`);
      }
    } catch {
      toast.error("Failed to fetch metadata");
    } finally {
      setFetching(false);
    }
  };

  const toggleField = (index: number) => {
    setFetchedFields((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], accepted: !updated[index].accepted };

      // Update form accordingly
      const f = updated[index];
      const fieldMap: Record<string, keyof typeof form> = {
        abstract: "abstract",
        authors: "authors",
        year: "year",
        venue: "venue",
        doi: "doi",
      };
      const key = fieldMap[f.field];
      if (key) {
        setForm((prev) => ({
          ...prev,
          [key]: f.accepted ? f.newValue : f.oldValue,
        }));
      }
      return updated;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/papers/${paperId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          abstract: form.abstract || undefined,
          authors: form.authors
            ? form.authors.split(",").map((a) => a.trim())
            : undefined,
          year: form.year ? parseInt(form.year) : undefined,
          venue: form.venue || undefined,
          doi: form.doi || undefined,
        }),
      });
      if (res.ok) {
        toast.success("Metadata saved");
        onOpenChange(false);
        onSaved();
      } else {
        toast.error("Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const FIELD_LABELS: Record<string, string> = {
    abstract: "Abstract",
    authors: "Authors",
    year: "Year",
    venue: "Venue",
    doi: "DOI",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Paper Metadata</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Re-fetch banner */}
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
            <div className="flex-1">
              <p className="text-sm font-medium">Auto-fill from databases</p>
              <p className="text-xs text-muted-foreground">
                Search OpenAlex, Semantic Scholar, and CrossRef
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRefetch}
              disabled={fetching}
            >
              {fetching ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {fetching ? "Searching..." : "Fetch"}
            </Button>
          </div>

          {/* Fetched fields review */}
          {fetchedFields.length > 0 && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20 p-3 space-y-2 overflow-hidden">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                Found from {fetchSource}:
              </p>
              {fetchedFields.map((f, i) => (
                <button
                  key={f.field}
                  onClick={() => toggleField(i)}
                  className={`flex items-start gap-2 w-full text-left rounded-md px-2 py-1.5 text-xs transition-colors ${
                    f.accepted
                      ? "bg-emerald-100/80 dark:bg-emerald-900/30"
                      : "bg-muted/50 opacity-60"
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 rounded-sm border h-3.5 w-3.5 flex items-center justify-center ${
                    f.accepted
                      ? "border-emerald-600 bg-emerald-600 text-white"
                      : "border-muted-foreground/30"
                  }`}>
                    {f.accepted && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="flex-1 min-w-0 overflow-hidden">
                    <span className="font-medium text-foreground">{FIELD_LABELS[f.field] || f.field}</span>
                    <span className="block text-muted-foreground break-words line-clamp-2">{f.newValue}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Form fields */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label className="text-xs">Title</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">Authors (comma-separated)</Label>
              <Input
                value={form.authors}
                onChange={(e) => setForm({ ...form, authors: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Year</Label>
              <Input
                type="number"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Venue</Label>
              <Input
                value={form.venue}
                onChange={(e) => setForm({ ...form, venue: e.target.value })}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">DOI</Label>
              <Input
                value={form.doi}
                onChange={(e) => setForm({ ...form, doi: e.target.value })}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs">Abstract</Label>
              <Textarea
                rows={4}
                value={form.abstract}
                onChange={(e) => setForm({ ...form, abstract: e.target.value })}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs mb-1.5 block">Tags</Label>
              <TagPicker
                paperId={paperId}
                currentTags={tags}
                onUpdate={onSaved}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
