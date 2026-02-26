"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { HighlightTooltip } from "./highlight-tooltip";

interface SelectionHighlighterProps {
  paperId: string;
  containerRef: React.RefObject<HTMLElement | null>;
}

interface ConversationHighlight {
  id: string;
  selectedText: string;
  mode: string | null;
  preview: string | null;
  messageCount: number;
}

interface HoverState {
  conversations: {
    id: string;
    mode: string;
    preview: string | null;
    messageCount: number;
  }[];
  selectedText: string;
  rect: DOMRect;
}

interface MatchRange {
  start: number;
  end: number;
  convIds: string[];
  primaryMode: string;
}

const MARK_ATTR = "data-selection-highlight";

/**
 * Highlights text passages that have associated explain/chat conversations.
 * Walks the DOM after render, wraps matches in <mark> elements, and shows
 * a rich tooltip card on hover.
 */
export function SelectionHighlighter({
  paperId,
  containerRef,
}: SelectionHighlighterProps) {
  const highlightsRef = useRef<ConversationHighlight[]>([]);
  const observerRef = useRef<MutationObserver | null>(null);

  // Hover tooltip state
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const suppressedRef = useRef(false);

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const startHoverHide = useCallback(() => {
    if (pinnedRef.current) return;
    cancelHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      setHoverState(null);
    }, 200);
  }, [cancelHoverTimer]);

  const handlePin = useCallback(() => {
    pinnedRef.current = true;
    cancelHoverTimer();
  }, [cancelHoverTimer]);

  const handleDismiss = useCallback(() => {
    pinnedRef.current = false;
    setHoverState(null);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchHighlights = useCallback(async () => {
    try {
      const res = await fetch(`/api/papers/${paperId}/conversations`);
      if (!res.ok) return;
      const conversations = await res.json();
      highlightsRef.current = conversations
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c.selectedText)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => ({
          id: c.id,
          selectedText: c.selectedText,
          mode: c.mode,
          preview: c.messages?.[0]?.content || null,
          messageCount: c._count?.messages || 0,
        }));
    } catch {
      // Ignore fetch errors
    }
  }, [paperId]);

  const clearHighlights = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const marks = container.querySelectorAll(`mark[${MARK_ATTR}]`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      const text = document.createTextNode(mark.textContent || "");
      parent.replaceChild(text, mark);
      parent.normalize();
    });
  }, [containerRef]);

  const applyHighlights = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Disconnect observer while we mutate the DOM to prevent infinite loops
    observerRef.current?.disconnect();

    try {
      clearHighlights();

      if (highlightsRef.current.length === 0) return;

      // Build flat text from all text nodes
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        null
      );

      const textNodes: { node: Text; start: number }[] = [];
      let flatText = "";

      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const parent = node.parentElement;
        if (
          parent &&
          (parent.tagName === "SCRIPT" ||
            parent.tagName === "STYLE" ||
            parent.tagName === "TEXTAREA" ||
            parent.tagName === "INPUT")
        ) {
          continue;
        }
        textNodes.push({ node, start: flatText.length });
        flatText += node.textContent || "";
      }

      if (!flatText) return;

      // Group conversations by normalized selectedText so overlapping
      // selections produce one mark with multiple conv IDs
      const textGroups = new Map<string, ConversationHighlight[]>();
      for (const h of highlightsRef.current) {
        const key = h.selectedText.trim().replace(/\s+/g, " ").toLowerCase();
        const group = textGroups.get(key) || [];
        group.push(h);
        textGroups.set(key, group);
      }

      // Find match ranges — one per unique text group
      const matchRanges: MatchRange[] = [];

      textGroups.forEach((group) => {
        const escaped = group[0].selectedText.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );
        const flexPattern = escaped.replace(/\s+/g, "\\s+");

        try {
          const regex = new RegExp(flexPattern, "i");
          const match = regex.exec(flatText);
          if (match) {
            const hasExplain = group.some((c) => c.mode === "explain");
            matchRanges.push({
              start: match.index,
              end: match.index + match[0].length,
              convIds: group.map((c) => c.id),
              primaryMode: hasExplain ? "explain" : "chat",
            });
          }
        } catch {
          // Invalid regex — skip
        }
      });

      // Sort descending so we can apply without invalidating positions
      matchRanges.sort((a, b) => b.start - a.start);

      for (const range of matchRanges) {
        wrapRange(
          textNodes,
          range.start,
          range.end,
          range.convIds,
          range.primaryMode
        );
      }
    } finally {
      // Reconnect observer
      if (observerRef.current && container) {
        observerRef.current.observe(container, {
          childList: true,
          subtree: true,
        });
      }
    }
  }, [containerRef, clearHighlights]);

  // Initial fetch + apply
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      await fetchHighlights();
      if (!cancelled) {
        requestAnimationFrame(() => {
          if (!cancelled) applyHighlights();
        });
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [fetchHighlights, applyHighlights]);

  // MutationObserver for tab switches
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceId: number | null = null;

    const observer = new MutationObserver(() => {
      if (debounceId !== null) cancelAnimationFrame(debounceId);
      debounceId = requestAnimationFrame(() => {
        debounceId = null;
        applyHighlights();
      });
    });

    observerRef.current = observer;
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      if (debounceId !== null) cancelAnimationFrame(debounceId);
      observer.disconnect();
      observerRef.current = null;
    };
  }, [containerRef, applyHighlights]);

  // Listen for paper-highlights-changed events
  useEffect(() => {
    const handler = async () => {
      await fetchHighlights();
      applyHighlights();
    };

    window.addEventListener("paper-highlights-changed", handler);
    return () =>
      window.removeEventListener("paper-highlights-changed", handler);
  }, [fetchHighlights, applyHighlights]);

  // Suppress tooltip while InlineChat is active
  useEffect(() => {
    const handler = (e: Event) => {
      suppressedRef.current = (e as CustomEvent).detail?.active ?? false;
      if (suppressedRef.current) {
        setHoverState(null);
      }
    };
    window.addEventListener("inline-chat-active", handler);
    return () => window.removeEventListener("inline-chat-active", handler);
  }, []);

  // Hover delegation (mouseover/mouseout bubble, unlike mouseenter/mouseleave)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseOver = (e: MouseEvent) => {
      if (suppressedRef.current) return;

      const mark = (e.target as HTMLElement).closest?.(
        `mark[${MARK_ATTR}]`
      ) as HTMLElement | null;
      if (!mark) return;

      cancelHoverTimer();

      const convIds = (mark.getAttribute("data-conv-ids") || "").split(",");
      const conversations = highlightsRef.current
        .filter((h) => convIds.includes(h.id))
        .map((h) => ({
          id: h.id,
          mode: h.mode || "chat",
          preview: h.preview,
          messageCount: h.messageCount,
        }));

      if (conversations.length === 0) return;

      // Find the original selectedText from the first conversation
      const firstConv = highlightsRef.current.find((h) =>
        convIds.includes(h.id)
      );

      setHoverState({
        conversations,
        selectedText: firstConv?.selectedText || mark.textContent || "",
        rect: mark.getBoundingClientRect(),
      });
    };

    const handleMouseOut = (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest?.(
        `mark[${MARK_ATTR}]`
      ) as HTMLElement | null;
      if (!mark) return;

      // Don't hide if moving to the tooltip
      const related = e.relatedTarget as HTMLElement | null;
      if (related && tooltipRef.current?.contains(related)) return;

      startHoverHide();
    };

    container.addEventListener("mouseover", handleMouseOver);
    container.addEventListener("mouseout", handleMouseOut);
    return () => {
      container.removeEventListener("mouseover", handleMouseOver);
      container.removeEventListener("mouseout", handleMouseOut);
    };
  }, [containerRef, cancelHoverTimer, startHoverHide]);

  // Dismiss tooltip on scroll (only if not pinned)
  useEffect(() => {
    if (!hoverState) return;

    const handleScroll = () => {
      if (!pinnedRef.current) setHoverState(null);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [hoverState]);

  return hoverState ? (
    <HighlightTooltip
      paperId={paperId}
      conversations={hoverState.conversations}
      selectedText={hoverState.selectedText}
      rect={hoverState.rect}
      onMouseEnter={cancelHoverTimer}
      onMouseLeave={startHoverHide}
      onPin={handlePin}
      onDismiss={handleDismiss}
      tooltipRef={tooltipRef}
    />
  ) : null;
}

/**
 * Wrap a character range [start, end) across text nodes with a <mark> element.
 */
function wrapRange(
  textNodes: { node: Text; start: number }[],
  start: number,
  end: number,
  convIds: string[],
  primaryMode: string
) {
  for (let i = 0; i < textNodes.length; i++) {
    const { node, start: nodeStart } = textNodes[i];
    const nodeEnd = nodeStart + (node.textContent?.length || 0);

    if (nodeEnd <= start || nodeStart >= end) continue;

    const overlapStart = Math.max(0, start - nodeStart);
    const overlapEnd = Math.min(
      node.textContent?.length || 0,
      end - nodeStart
    );

    if (overlapStart >= overlapEnd) continue;

    let targetNode = node;

    if (overlapEnd < (targetNode.textContent?.length || 0)) {
      targetNode.splitText(overlapEnd);
    }

    if (overlapStart > 0) {
      targetNode = targetNode.splitText(overlapStart);
    }

    const mark = document.createElement("mark");
    mark.setAttribute(MARK_ATTR, "true");
    mark.setAttribute("data-conv-ids", convIds.join(","));
    mark.setAttribute("data-conv-mode", primaryMode);
    mark.className =
      primaryMode === "explain"
        ? "selection-highlight-explain"
        : "selection-highlight-chat";

    targetNode.parentNode?.replaceChild(mark, targetNode);
    mark.appendChild(targetNode);

    if (nodeEnd >= end) break;
  }
}
