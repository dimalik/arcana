"use client";

import { Badge } from "@/components/ui/badge";
import type { AnswerCitation } from "@/lib/papers/answer-engine/metadata";

interface ConversationArtifactRecord {
  id: string;
  kind: string;
  title: string;
  payloadJson: string;
}

interface ChatMessageSupportProps {
  citations?: AnswerCitation[];
  artifacts?: ConversationArtifactRecord[];
  compact?: boolean;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function ArtifactPreview({
  artifact,
  compact,
}: {
  artifact: ConversationArtifactRecord;
  compact: boolean;
}) {
  const baseClass = compact ? "text-[11px]" : "text-xs";

  if (artifact.kind === "CLAIM_LIST") {
    const payload = parseJson<{
      claims?: Array<{ text: string; rhetoricalRole: string }>;
    }>(artifact.payloadJson);
    const claims = payload?.claims ?? [];
    return (
      <div className="space-y-1">
        {claims.slice(0, compact ? 2 : 3).map((claim, index) => (
          <p key={`${artifact.id}-claim-${index}`} className={`${baseClass} text-muted-foreground`}>
            {claim.text}
          </p>
        ))}
      </div>
    );
  }

  if (artifact.kind === "CONTRADICTION_TABLE") {
    const payload = parseJson<{
      contradictions?: Array<{
        newPaperClaim: string;
        conflictingPaperClaim: string;
      }>;
      summary?: string;
    }>(artifact.payloadJson);
    const first = payload?.contradictions?.[0];
    return (
      <div className="space-y-1">
        {first ? (
          <>
            <p className={`${baseClass} text-muted-foreground`}>{first.newPaperClaim}</p>
            <p className={`${baseClass} text-muted-foreground`}>{first.conflictingPaperClaim}</p>
          </>
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.summary ?? "No contradiction candidates."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "GAP_LIST") {
    const payload = parseJson<{
      gaps?: Array<{ title: string }>;
      overallAssessment?: string;
    }>(artifact.payloadJson);
    const gaps = payload?.gaps ?? [];
    return (
      <div className="space-y-1">
        {gaps.length > 0 ? (
          gaps.slice(0, compact ? 2 : 3).map((gap, index) => (
            <p key={`${artifact.id}-gap-${index}`} className={`${baseClass} text-muted-foreground`}>
              {gap.title}
            </p>
          ))
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.overallAssessment ?? "No structured gaps were produced."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "TIMELINE") {
    const payload = parseJson<{
      timeline?: Array<{ year: number; keyAdvance: string }>;
      narrative?: string;
    }>(artifact.payloadJson);
    const timeline = payload?.timeline ?? [];
    return (
      <div className="space-y-1">
        {timeline.length > 0 ? (
          timeline.slice(0, compact ? 2 : 3).map((entry, index) => (
            <p key={`${artifact.id}-timeline-${index}`} className={`${baseClass} text-muted-foreground`}>
              {entry.year}: {entry.keyAdvance}
            </p>
          ))
        ) : (
          <p className={`${baseClass} text-muted-foreground`}>
            {payload?.narrative ?? "No timeline entries were produced."}
          </p>
        )}
      </div>
    );
  }

  if (artifact.kind === "METHODOLOGY_COMPARE") {
    const payload = parseJson<{
      verdict?: string;
      comparison?: { papers?: Array<{ title: string; approach: string }> };
    }>(artifact.payloadJson);
    return (
      <div className="space-y-1">
        {(payload?.comparison?.papers ?? []).slice(0, compact ? 2 : 3).map((paper, index) => (
          <p key={`${artifact.id}-method-${index}`} className={`${baseClass} text-muted-foreground`}>
            {paper.title}: {paper.approach}
          </p>
        ))}
        {payload?.verdict ? (
          <p className={`${baseClass} font-medium text-foreground/80`}>{payload.verdict}</p>
        ) : null}
      </div>
    );
  }

  return (
    <p className={`${baseClass} text-muted-foreground`}>
      Structured artifact attached.
    </p>
  );
}

export function ChatMessageSupport({
  citations = [],
  artifacts = [],
  compact = false,
}: ChatMessageSupportProps) {
  if (citations.length === 0 && artifacts.length === 0) return null;

  const wrapperClass = compact ? "mt-2 space-y-2" : "mt-3 space-y-3";

  return (
    <div className={wrapperClass}>
      {citations.length > 0 ? (
        <div className="space-y-1.5">
          <p className={compact ? "text-[10px] font-medium text-muted-foreground" : "text-[11px] font-medium text-muted-foreground"}>
            Sources
          </p>
          <div className="space-y-1.5">
            {citations.map((citation, index) => (
              <div
                key={`${citation.paperId}-${index}`}
                className="rounded-md border bg-background/70 px-2.5 py-2"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    S{index + 1}
                  </Badge>
                  <p className={compact ? "text-[10px] font-medium" : "text-[11px] font-medium"}>
                    {citation.paperTitle}
                  </p>
                </div>
                <p className={compact ? "text-[10px] text-muted-foreground" : "text-[11px] text-muted-foreground"}>
                  {citation.snippet}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {artifacts.length > 0 ? (
        <div className="space-y-1.5">
          <p className={compact ? "text-[10px] font-medium text-muted-foreground" : "text-[11px] font-medium text-muted-foreground"}>
            Artifacts
          </p>
          <div className="space-y-1.5">
            {artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="rounded-md border bg-background/70 px-2.5 py-2"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    {artifact.kind.toLowerCase()}
                  </Badge>
                  <p className={compact ? "text-[10px] font-medium" : "text-[11px] font-medium"}>
                    {artifact.title}
                  </p>
                </div>
                <ArtifactPreview artifact={artifact} compact={compact} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
