"use client";

import { Separator } from "@/components/ui/separator";
import { RelatedPapers } from "@/components/relations/related-papers";
import { PaperReferences } from "@/components/references/paper-references";
import { DiscoveredPapers } from "@/components/connections/discovered-papers";

interface PaperConnectionsProps {
  paperId: string;
  paperTitle: string;
}

export function PaperConnections({
  paperId,
  paperTitle,
}: PaperConnectionsProps) {
  return (
    <div className="space-y-6">
      {/* Related Papers */}
      <section>
        <h3 className="text-sm font-medium mb-3">Related Papers</h3>
        <RelatedPapers paperId={paperId} />
      </section>

      <Separator />

      {/* References */}
      <section>
        <PaperReferences paperId={paperId} />
      </section>

      {/* Discovered Papers — shows start button if none, or results + redo menu */}
      <DiscoveredPapers paperId={paperId} paperTitle={paperTitle} />
    </div>
  );
}
