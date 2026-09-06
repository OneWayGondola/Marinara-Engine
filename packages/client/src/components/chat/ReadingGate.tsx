// ──────────────────────────────────────────────
// Chat: Reading gate — the newest reply, one paragraph at a time
// ──────────────────────────────────────────────
//
// Reveals the finished reply paragraph by paragraph. There is deliberately no
// "show all": unseen text is not skippable (the visual-novel default), and the
// composer stays blocked through `readingGateOpenKey` until the last paragraph
// is open. Space or Enter with nothing editable focused advances, as does a
// click on the edge. ArrowRight is NOT used — intuitive swipe navigation owns
// it on the latest reply, and past the last swipe it generates a new one.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useUIStore } from "../../stores/ui.store";
import { isReadingGateAdvanceKey, segmentForReadingGate, visibleReadingGateMarkdown } from "../../lib/reading-gate";

interface ReadingGateProps {
  /** `${messageId}:${activeSwipeIndex}` — the gate re-arms when either changes. */
  gateKey: string;
  /** The reply's markdown source, after the same display transforms the full render gets. */
  text: string;
  /** The message's own renderer, so revealed paragraphs look exactly as they would ungated. */
  render: (markdown: string) => ReactNode;
}

export function ReadingGate({ gateKey, text, render }: ReadingGateProps) {
  const { t: localizeUi } = useUiTranslation();
  const readThroughKeys = useUIStore((s) => s.readingGateReadThrough);
  const markReadThrough = useUIStore((s) => s.markReadingGateReadThrough);
  const setOpenKey = useUIStore((s) => s.setReadingGateOpenKey);
  const releaseOpenKey = useUIStore((s) => s.releaseReadingGateOpenKey);

  const segments = useMemo(() => segmentForReadingGate(text), [text]);
  const total = segments.paragraphs.length;
  const gated = total > 1 && !readThroughKeys.includes(gateKey);

  const [revealed, setRevealed] = useState(1);
  const startedAtRef = useRef(Date.now());
  useEffect(() => {
    setRevealed(1);
    startedAtRef.current = Date.now();
  }, [gateKey]);

  // Hold the composer while the gate is open; release when it closes or unmounts.
  useEffect(() => {
    if (!gated) return;
    setOpenKey(gateKey);
    return () => releaseOpenKey(gateKey);
  }, [gated, gateKey, setOpenKey, releaseOpenKey]);

  // The last paragraph opening is the read-through; recorded once, with its duration.
  useEffect(() => {
    if (gated && revealed >= total) markReadThrough(gateKey, Date.now() - startedAtRef.current);
  }, [gated, revealed, total, gateKey, markReadThrough]);

  const advance = useCallback(() => {
    setRevealed((n) => Math.min(total, n + 1));
  }, [total]);

  useEffect(() => {
    if (!gated) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isReadingGateAdvanceKey(event)) return;
      event.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gated, advance]);

  // Each reveal scrolls the message list to its end, the way a visual-novel textbox sits
  // at the bottom of the screen: the reading position never moves. The list, not the edge —
  // aligning the edge alone left the swipe row and bottom padding below the fold. Same move
  // as ChatArea's scrollToMessagesBottom, reached through the container's data hook.
  const edgeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!gated || revealed <= 1) return;
    const container = edgeRef.current?.closest<HTMLElement>("[data-chat-scroll]");
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    else edgeRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [gated, revealed]);

  if (!gated) return <>{render(text)}</>;

  return (
    <>
      {render(visibleReadingGateMarkdown(segments, revealed))}
      <button
        ref={edgeRef}
        type="button"
        onClick={advance}
        className="mari-reading-gate-edge mt-3 flex w-full items-center justify-between rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)]/70"
        aria-label={localizeUi("ui.chat.readinggate.revealNext", { next: revealed + 1, total })}
      >
        <span className="tabular-nums">{localizeUi("ui.chat.readinggate.progress", { current: revealed, total })}</span>
        <span className="flex items-center gap-1">
          {localizeUi("ui.chat.readinggate.continue")}
          <ChevronRight size="0.75rem" />
        </span>
      </button>
    </>
  );
}
