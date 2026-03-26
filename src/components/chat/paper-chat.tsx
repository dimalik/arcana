"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, ArrowUp, History, Paperclip } from "lucide-react";
import { ConversationList } from "./conversation-list";
import { ConversationView } from "./conversation-view";
import { InlineChat } from "./inline-chat";
import { SelectionPopover } from "./selection-popover";

interface PaperChatProps {
  paperId: string;
  hasText: boolean;
  initialConversationId?: string;
  className?: string;
  docked?: boolean;
  dockedOpen?: boolean;
  onDockedToggle?: () => void;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
}

type View = "list" | "chat";

interface InlineChatState {
  conversationId: string;
  mode: "explain" | "chat";
  selectedText: string;
  yOffset: number;
}

export function PaperChat({ paperId, hasText, initialConversationId, className, docked, dockedOpen, onDockedToggle, scrollContainerRef }: PaperChatProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>(docked ? "chat" : "list");
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
  const [chatWidth, setChatWidth] = useState(() => {
    if (typeof window === "undefined") return 380;
    return parseInt(localStorage.getItem("paper-chat-width") || "380") || 380;
  });

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = chatWidth;
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(300, Math.min(700, startWidth + (startX - ev.clientX)));
      setChatWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("paper-chat-width", String(chatWidth));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [chatWidth]);

  // Persist width on change
  useEffect(() => { localStorage.setItem("paper-chat-width", String(chatWidth)); }, [chatWidth]);

  // Suppresses auto-create when user is intentionally browsing history
  const browsingHistory = useRef(false);

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

  // Reset state when docked panel closes
  const handleDockedClose = useCallback(() => {
    browsingHistory.current = false;
    setActiveConversationId(null);
    setView("chat");
    onDockedToggle?.();
  }, [onDockedToggle]);

  // "c" hotkey to toggle chat panel, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        if (e.key === "Escape" && docked && dockedOpen) {
          handleDockedClose();
        }
        return;
      }
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (docked) {
          if (dockedOpen) {
            handleDockedClose();
          } else {
            onDockedToggle?.();
          }
        } else {
          setOpen((prev) => !prev);
        }
      }
      if (e.key === "Escape") {
        if (docked && dockedOpen) {
          handleDockedClose();
        } else {
          setOpen(false);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [docked, dockedOpen, onDockedToggle, handleDockedClose]);

  /** Compute yOffset from a selection rect relative to the scroll container */
  const computeYOffset = useCallback((rect: DOMRect): number => {
    const container = scrollContainerRef?.current;
    if (!container) return rect.top;
    const containerRect = container.getBoundingClientRect();
    return rect.top - containerRect.top + container.scrollTop;
  }, [scrollContainerRef]);

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

      // Compute yOffset from selection rect
      const rect = new DOMRect(pos.x, pos.rectTop, 0, pos.rectBottom - pos.rectTop);
      const yOffset = computeYOffset(rect);

      setInlineChat({
        conversationId: data.id,
        mode,
        selectedText: text,
        yOffset,
      });

      // Notify highlighter about the new conversation
      window.dispatchEvent(new CustomEvent("paper-highlights-changed"));
      window.dispatchEvent(new CustomEvent("inline-chat-active", { detail: { active: true } }));
    },
    [paperId, selectionPopover, computeYOffset]
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

      // Compute yOffset from the event rect
      const domRect = rect
        ? new DOMRect(rect.left, rect.top, rect.width, rect.height)
        : new DOMRect(0, 0, 0, 0);
      const yOffset = computeYOffset(domRect);

      setInlineChat({
        conversationId: data.id,
        mode,
        selectedText,
        yOffset,
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
  }, [handleOpenMatchedConversation, paperId, computeYOffset]);

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
    browsingHistory.current = false;
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(id);
    setView("chat");
  };

  const handleNewConversation = (id: string) => {
    browsingHistory.current = false;
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

  const handleDockedNewChat = () => {
    browsingHistory.current = false;
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(null);
    setView("chat");
  };

  const handleDockedShowHistory = () => {
    browsingHistory.current = true;
    setView("list");
    setListRefreshKey((k) => k + 1);
  };

  // Return to chat from history (docked mode)
  const handleDockedBackToChat = useCallback(() => {
    browsingHistory.current = false;
    setView("chat");
  }, []);

  // Create conversation on first message (deferred creation)
  const handleFirstMessage = useCallback(
    async (text: string) => {
      const res = await fetch(`/api/papers/${paperId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setPendingMessage(text);
      setActiveConversationId(data.id);
      setView("chat");
      setListRefreshKey((k) => k + 1);
    },
    [paperId]
  );

  const handleClose = () => {
    setOpen(false);
    setPendingMessage(undefined);
    setPendingContext(undefined);
    setActiveConversationId(null);
    setView("list");
  };

  // Fallback ref if none provided
  const fallbackRef = useRef<HTMLElement>(null);
  const effectiveScrollRef = scrollContainerRef ?? fallbackRef;

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

      {/* Margin annotation card */}
      {inlineChat && (
        <InlineChat
          key={inlineChat.conversationId}
          paperId={paperId}
          conversationId={inlineChat.conversationId}
          selectedText={inlineChat.selectedText}
          mode={inlineChat.mode}
          yOffset={inlineChat.yOffset}
          scrollContainerRef={effectiveScrollRef}
          onClose={handleCloseInline}
          onOpenFull={handleOpenFullFromInline}
        />
      )}

      {/* ── Docked mode — fixed panel left of right strip ── */}
      {docked ? (
        dockedOpen && (
          <div className="fixed top-12 bottom-0 right-10 z-30 flex flex-col border-l bg-card shadow-lg" style={{ width: chatWidth }}>
            {/* Resize handle */}
            <div
              onMouseDown={startResize}
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
            />
            {view === "list" ? (
              <ConversationList
                paperId={paperId}
                expanded={false}
                onToggleExpand={() => {}}
                onClose={handleDockedClose}
                onSelectConversation={handleSelectConversation}
                onNewConversation={handleNewConversation}
                refreshKey={listRefreshKey}
                hideControls
                onBack={activeConversationId ? handleDockedBackToChat : undefined}
                onSendNew={handleFirstMessage}
              />
            ) : activeConversationId ? (
              <ConversationView
                key={activeConversationId}
                paperId={paperId}
                conversationId={activeConversationId}
                initialMessage={pendingMessage}
                selectedContext={pendingContext}
                expanded={false}
                onToggleExpand={() => {}}
                onClose={handleDockedClose}
                onBack={handleBack}
                hideControls
                onNewChat={handleDockedNewChat}
                onShowHistory={handleDockedShowHistory}
              />
            ) : (
              <NewChatInput
                onSend={handleFirstMessage}
                onShowHistory={handleDockedShowHistory}
              />
            )}
          </div>
        )
      ) : (
        <>
          {/* Floating chat button */}
          {!open && (
            <button
              onClick={() => setOpen(true)}
              className={`fixed bottom-6 ${className ?? "right-6"} z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95`}
            >
              <MessageSquare className="h-6 w-6" />
            </button>
          )}

          {/* Floating chat panel */}
          {open && (
            <div
              className={`fixed bottom-6 ${className ?? "right-6"} z-50 flex flex-col rounded-xl border bg-card shadow-2xl`}
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
              ) : (
                <NewChatInput
                  onSend={handleFirstMessage}
                  onShowHistory={() => { setView("list"); setListRefreshKey((k) => k + 1); }}
                />
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Lightweight input shown before any conversation exists — no DB record until send. */
function NewChatInput({
  onSend,
  onShowHistory,
}: {
  onSend: (text: string) => void;
  onShowHistory: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setInput("");
    onSend(text);
  };

  return (
    <>
      {/* History icon */}
      <div className="flex items-center justify-end px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          onClick={onShowHistory}
          title="Chat history"
        >
          <History className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Empty state + suggestions */}
      <div className="flex-1 overflow-y-auto px-4">
        <div className="flex min-h-full flex-col items-center justify-end gap-2 pb-4 text-center">
          <p className="text-sm text-muted-foreground">
            Ask anything about this paper
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-1.5">
            {["Key contributions", "Explain the methodology", "Limitations?"].map(
              (suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  disabled={sending}
                  onClick={() => handleSend(suggestion)}
                >
                  {suggestion}
                </Button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Input */}
      <div className="p-3">
        <div className="relative rounded-2xl border border-muted-foreground/20 focus-within:border-muted-foreground/40 transition-colors">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Chat about the paper"
            rows={3}
            className="min-h-[80px] resize-none border-0 shadow-none focus-visible:ring-0 pr-12 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(input);
              }
            }}
          />
          <span
            className="absolute top-2 right-2.5 flex h-7 w-7 items-center justify-center text-muted-foreground/30"
            title="Add paper context after starting a chat"
          >
            <Paperclip className="h-4 w-4" />
          </span>
          <button
            onClick={() => handleSend(input)}
            disabled={sending || !input.trim()}
            className="absolute bottom-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-muted-foreground/15 text-muted-foreground transition-colors hover:bg-muted-foreground/25 disabled:opacity-40 disabled:hover:bg-muted-foreground/15"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}
