"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { ConversationList } from "./conversation-list";
import { ConversationView } from "./conversation-view";
import { InlineChat } from "./inline-chat";
import { SelectionPopover } from "./selection-popover";

interface PaperChatProps {
  paperId: string;
  hasText: boolean;
  initialConversationId?: string;
}

type View = "list" | "chat";

interface InlineChatState {
  conversationId: string;
  mode: "explain" | "chat";
  selectedText: string;
  position: { x: number; y: number; placement: "above" | "below" };
}

export function PaperChat({ paperId, hasText, initialConversationId }: PaperChatProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>("list");
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [pendingMessage, setPendingMessage] = useState<string | undefined>(
    undefined
  );
  const [pendingContext, setPendingContext] = useState<string | undefined>(
    undefined
  );
  const [listRefreshKey, setListRefreshKey] = useState(0);

  // Inline card state (separate from floating panel)
  const [inlineChat, setInlineChat] = useState<InlineChatState | null>(null);

  // Selection popover state — store selection rect bounds for inline card positioning
  const [selectionPopover, setSelectionPopover] = useState<{
    text: string;
    x: number;
    y: number;
    placement: "above" | "below";
    rectTop: number;
    rectBottom: number;
  } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-open a specific conversation (e.g., from ?conv= URL param)
  useEffect(() => {
    if (initialConversationId) {
      setOpen(true);
      setView("chat");
      setActiveConversationId(initialConversationId);
    }
  }, [initialConversationId]);

  // "c" hotkey to toggle chat panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in inputs, textareas, or contenteditable
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Text selection handler
  useEffect(() => {
    const handleMouseUp = () => {
      if (popoverTimeout.current) clearTimeout(popoverTimeout.current);
      popoverTimeout.current = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (text && text.length > 3 && text.length < 5000) {
          const range = selection!.getRangeAt(0);
          const rect = range.getBoundingClientRect();

          const buttonHeight = 32;
          const margin = 8;

          const placement =
            rect.top - buttonHeight - margin < 16 ? "below" : "above";

          const x = Math.max(
            80,
            Math.min(rect.left + rect.width / 2, window.innerWidth - 80)
          );
          const y =
            placement === "above" ? rect.top - margin : rect.bottom + margin;

          setSelectionPopover({
            text,
            x,
            y,
            placement,
            rectTop: rect.top,
            rectBottom: rect.bottom,
          });
        } else {
          setSelectionPopover(null);
        }
      }, 200);
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        popoverRef.current.contains(e.target as Node)
      ) {
        return;
      }
      setSelectionPopover(null);
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
      if (popoverTimeout.current) clearTimeout(popoverTimeout.current);
    };
  }, []);

  const openInlineCard = useCallback(
    async (mode: "explain" | "chat") => {
      const pos = selectionPopover;
      if (!pos) return;
      const text = pos.text;

      setSelectionPopover(null);
      window.getSelection()?.removeAllRanges();

      // Create conversation with selectedText and mode
      const res = await fetch(`/api/papers/${paperId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText: text, mode }),
      });
      const data = await res.json();

      // Position inline card relative to selection
      const cardHeight = 300;
      const spaceBelow = window.innerHeight - pos.rectBottom - 12;
      const placement = spaceBelow >= cardHeight ? "below" : "above";

      setInlineChat({
        conversationId: data.id,
        mode,
        selectedText: text,
        position: {
          x: pos.x,
          y: placement === "below" ? pos.rectBottom + 8 : pos.rectTop - 8,
          placement,
        },
      });

      // Notify highlighter about the new conversation
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
      window.dispatchEvent(new CustomEvent("inline-chat-active", { detail: { active: true } }));
    },
    [paperId, selectionPopover]
  );

  const handleCloseInline = useCallback(async () => {
    const convId = inlineChat?.conversationId;
    setInlineChat(null);

    // Auto-delete conversations with no messages (accidental opens)
    if (convId) {
      try {
        const res = await fetch(
          `/api/papers/${paperId}/conversations/${convId}/messages`
        );
        if (res.ok) {
          const messages = await res.json();
          if (messages.length === 0) {
            await fetch(
              `/api/papers/${paperId}/conversations/${convId}`,
              { method: "DELETE" }
            );
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    setListRefreshKey((k) => k + 1);
    window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
    window.dispatchEvent(new CustomEvent("inline-chat-active", { detail: { active: false } }));
  }, [inlineChat, paperId]);

  const handleOpenFullFromInline = useCallback((convId: string) => {
    setInlineChat(null);
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(convId);
    setView("chat");
    setOpen(true);
  }, []);

  const handleOpenMatchedConversation = useCallback((convId: string) => {
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(convId);
    setView("chat");
    setOpen(true);
  }, []);

  // Listen for highlight tooltip events from SelectionHighlighter
  useEffect(() => {
    const handleOpen = (e: Event) => {
      const { conversationId } = (e as CustomEvent).detail;
      if (conversationId) {
        handleOpenMatchedConversation(conversationId);
      }
    };

    const handleDelete = async (e: Event) => {
      const { conversationId } = (e as CustomEvent).detail;
      if (conversationId) {
        await fetch(`/api/papers/${paperId}/conversations/${conversationId}`, {
          method: "DELETE",
        });
        setListRefreshKey((k) => k + 1);
        window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
      }
    };

    const handleCreate = async (e: Event) => {
      const { selectedText, mode, rect } = (e as CustomEvent).detail;
      if (!selectedText || !mode) return;

      const res = await fetch(`/api/papers/${paperId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText, mode }),
      });
      const data = await res.json();

      // Open inline card near the highlighted text (not the floating panel)
      const cardHeight = 300;
      const spaceBelow = window.innerHeight - (rect?.bottom ?? 0) - 12;
      const placement = spaceBelow >= cardHeight ? "below" : "above";
      const x = rect
        ? Math.max(80, Math.min(rect.left + rect.width / 2, window.innerWidth - 80))
        : window.innerWidth / 2;

      setInlineChat({
        conversationId: data.id,
        mode,
        selectedText,
        position: {
          x,
          y: placement === "below" ? (rect?.bottom ?? 0) + 8 : (rect?.top ?? 0) - 8,
          placement,
        },
      });

      setListRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
      window.dispatchEvent(new CustomEvent("inline-chat-active", { detail: { active: true } }));
    };

    window.addEventListener("open-highlight-conversation", handleOpen);
    window.addEventListener("delete-highlight-conversation", handleDelete);
    window.addEventListener("create-highlight-conversation", handleCreate);
    return () => {
      window.removeEventListener("open-highlight-conversation", handleOpen);
      window.removeEventListener("delete-highlight-conversation", handleDelete);
      window.removeEventListener("create-highlight-conversation", handleCreate);
    };
  }, [handleOpenMatchedConversation, paperId]);

  const handleDeleteMatchedConversation = useCallback(
    async (convId: string) => {
      await fetch(`/api/papers/${paperId}/conversations/${convId}`, {
        method: "DELETE",
      });
      setListRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
    },
    [paperId]
  );

  const handleSelectConversation = (id: string) => {
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(id);
    setView("chat");
  };

  const handleNewConversation = (id: string) => {
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(id);
    setView("chat");
  };

  const handleBack = () => {
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(null);
    setView("list");
    setListRefreshKey((k) => k + 1);
  };

  const handleClose = () => {
    setOpen(false);
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(null);
    setView("list");
  };

  if (!hasText) return null;

  return (
    <>
      {/* Selection context menu */}
      {selectionPopover && (
        <SelectionPopover
          ref={popoverRef}
          paperId={paperId}
          text={selectionPopover.text}
          x={selectionPopover.x}
          y={selectionPopover.y}
          placement={selectionPopover.placement}
          onExplain={() => openInlineCard("explain")}
          onChat={() => openInlineCard("chat")}
          onOpenConversation={handleOpenMatchedConversation}
          onDeleteConversation={handleDeleteMatchedConversation}
        />
      )}

      {/* Inline card */}
      {inlineChat && (
        <InlineChat
          key={inlineChat.conversationId}
          paperId={paperId}
          conversationId={inlineChat.conversationId}
          selectedText={inlineChat.selectedText}
          mode={inlineChat.mode}
          position={inlineChat.position}
          onClose={handleCloseInline}
          onOpenFull={handleOpenFullFromInline}
        />
      )}

      {/* Floating chat button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <MessageSquare className="h-6 w-6" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-6 right-6 z-50 flex flex-col rounded-xl border bg-card shadow-2xl"
          style={{
            width: expanded ? 600 : 400,
            height: expanded ? "80vh" : 500,
          }}
        >
          {view === "list" ? (
            <ConversationList
              paperId={paperId}
              expanded={expanded}
              onToggleExpand={() => setExpanded(!expanded)}
              onClose={handleClose}
              onSelectConversation={handleSelectConversation}
              onNewConversation={handleNewConversation}
              refreshKey={listRefreshKey}
            />
          ) : activeConversationId ? (
            <ConversationView
              key={activeConversationId}
              paperId={paperId}
              conversationId={activeConversationId}
              initialMessage={pendingMessage}
              selectedContext={pendingContext}
              expanded={expanded}
              onToggleExpand={() => setExpanded(!expanded)}
              onClose={handleClose}
              onBack={handleBack}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
