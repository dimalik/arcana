"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";

interface SaveToNotebookParams {
  paperId: string;
  type: "selection" | "explanation" | "chat" | "note";
  selectedText?: string;
  content?: string;
  conversationId?: string;
  messageId?: string;
}

export function useNotebook() {
  const [saving, setSaving] = useState(false);

  const saveToNotebook = useCallback(async (params: SaveToNotebookParams) => {
    setSaving(true);
    try {
      const res = await fetch("/api/notebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        throw new Error("Failed to save");
      }
      toast.success("Saved to notebook");
    } catch {
      toast.error("Failed to save to notebook");
    } finally {
      setSaving(false);
    }
  }, []);

  return { saveToNotebook, saving };
}
