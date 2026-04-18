import type { ReferenceState } from "../references/reference-state";

export interface ProcessingStatusDisplayInput {
  processingStatus?: string | null;
  processingStep?: string | null;
  referenceState?: ReferenceState | string | null;
}

export interface ProcessingStatusDisplay {
  label: string | null;
  tone: "info" | "warning" | "danger" | "muted" | "none";
  showSpinner: boolean;
}

const STEP_LABELS: Record<string, string> = {
  extracting_text: "Extracting text",
  metadata: "Extracting metadata",
  summarize: "Generating summary",
  categorize: "Categorizing",
  linking: "Finding related papers",
  contradictions: "Detecting contradictions",
  references: "Extracting references",
  contexts: "Analyzing citations",
  distill: "Distilling insights",
};

const STATUS_LABELS: Record<string, Omit<ProcessingStatusDisplay, "showSpinner">> = {
  PENDING: { label: "Queued", tone: "muted" },
  DOWNLOADING: { label: "Downloading PDF", tone: "info" },
  EXTRACTING_TEXT: { label: "Extracting text", tone: "info" },
  TEXT_EXTRACTED: { label: "Queued for analysis", tone: "muted" },
  BATCH_PROCESSING: { label: "Batch processing", tone: "info" },
  NEEDS_DEFERRED: { label: "Waiting for deferred steps", tone: "muted" },
  FAILED: { label: "Processing failed", tone: "danger" },
  NO_PDF: { label: "No PDF", tone: "warning" },
  COMPLETED: { label: null, tone: "none" },
};

export function getProcessingStatusDisplay(
  input: ProcessingStatusDisplayInput,
): ProcessingStatusDisplay {
  if (
    input.processingStep &&
    input.processingStatus &&
    !["FAILED", "NO_PDF", "COMPLETED"].includes(input.processingStatus)
  ) {
    return {
      label: STEP_LABELS[input.processingStep] ?? input.processingStep,
      tone: "info",
      showSpinner: true,
    };
  }

  if (input.referenceState === "unavailable_no_pdf") {
    return {
      label: "No PDF",
      tone: "warning",
      showSpinner: false,
    };
  }

  const statusDisplay = STATUS_LABELS[input.processingStatus ?? ""];
  if (statusDisplay) {
    return {
      ...statusDisplay,
      showSpinner: statusDisplay.tone === "info",
    };
  }

  if (!input.processingStatus) {
    return {
      label: null,
      tone: "none",
      showSpinner: false,
    };
  }

  return {
    label: input.processingStatus,
    tone: "muted",
    showSpinner: false,
  };
}

export function getReferenceStateEmptyMessage(
  referenceState: ReferenceState | string | null | undefined,
): string {
  switch (referenceState) {
    case "unavailable_no_pdf":
      return "Reference extraction requires a PDF.";
    case "extraction_failed":
      return "Reference extraction failed. Try re-running.";
    case "pending":
      return "Reference extraction in progress.";
    case "available":
    default:
      return "No references were found in this paper.";
  }
}
