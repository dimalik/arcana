"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { RelatedPapers } from "@/components/relations/related-papers";
import { PaperReferences } from "@/components/references/paper-references";
import { Compass, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface PaperConnectionsProps {
  paperId: string;
  paperTitle: string;
}

export function PaperConnections({
  paperId,
  paperTitle,
}: PaperConnectionsProps) {
  const router = useRouter();
  const [relationsCount, setRelationsCount] = useState<number | null>(null);
  const [refsCount, setRefsCount] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState("");

  // Lightweight count fetches
  useEffect(() => {
    (async () => {
      const [relRes, refRes] = await Promise.all([
        fetch(`/api/papers/${paperId}/relations`).catch(() => null),
        fetch(`/api/papers/${paperId}/references`).catch(() => null),
      ]);
      if (relRes?.ok) {
        const data = await relRes.json();
        setRelationsCount(Array.isArray(data) ? data.length : 0);
      }
      if (refRes?.ok) {
        const data = await refRes.json();
        setRefsCount(Array.isArray(data) ? data.length : 0);
      }
    })();
  }, [paperId]);

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoveryProgress("Starting discovery...");

    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperIds: [paperId] }),
      });

      if (!res.ok || !res.body) {
        toast.error("Failed to start discovery");
        setDiscovering(false);
        setDiscoveryProgress("");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sessionId = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "session") {
              sessionId = event.sessionId;
            } else if (event.type === "progress") {
              setDiscoveryProgress(
                `Searching... ${event.found} found`
              );
            } else if (event.type === "done") {
              setDiscoveryProgress(
                `Found ${event.totalFound} papers`
              );
            }
          } catch {
            // skip
          }
        }
      }

      if (sessionId) {
        router.push(`/discovery/${sessionId}`);
      }
    } catch {
      toast.error("Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  const statsItems: string[] = [];
  if (relationsCount !== null) statsItems.push(`${relationsCount} related`);
  if (refsCount !== null) statsItems.push(`${refsCount} references`);

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      {statsItems.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {statsItems.join(" · ")}
        </p>
      )}

      {/* Related Papers */}
      <section>
        <h3 className="text-sm font-medium mb-3">Related Papers</h3>
        <RelatedPapers paperId={paperId} />
      </section>

      <Separator />

      {/* References */}
      <section>
        <h3 className="text-sm font-medium mb-3">References</h3>
        <PaperReferences paperId={paperId} />
      </section>

      <Separator />

      {/* Discover More */}
      <section>
        <h3 className="text-sm font-medium mb-2">Discover More</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Find more papers related to &ldquo;{paperTitle}&rdquo; by following
          citation chains.
        </p>
        <Button
          variant="outline"
          onClick={handleDiscover}
          disabled={discovering}
        >
          {discovering ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {discoveryProgress || "Starting..."}
            </>
          ) : (
            <>
              <Compass className="mr-2 h-4 w-4" />
              Start Discovery
            </>
          )}
        </Button>
      </section>
    </div>
  );
}
