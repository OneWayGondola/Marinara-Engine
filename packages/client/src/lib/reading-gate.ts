/**
 * Reading gate — split a finished reply into the model's own paragraphs so the
 * client can reveal them one at a time.
 *
 * Why paragraphs: the reader asked to lose the option to skip ahead to the
 * dialogue, not to be paced word-by-word. The paragraph is the unit the
 * author already chose; a visual-novel style click-to-advance over those
 * units is the reference architecture (Ren'Py: unseen text is not skippable
 * by default).
 *
 * Tracker lines — metadata the engine appends, wrapped in em dashes such as
 * `— user: brush hook ×1 → hands —` — are not prose. Trailing paragraphs made
 * only of such lines are returned as `tail` and shown with the last paragraph
 * rather than counted as steps.
 */

export interface ReadingGateSegments {
  paragraphs: string[];
  tail: string;
}

const FENCE = /^\s*(```|~~~)/u;
const BLANK = /^\s*$/u;
// A line that begins and ends with a dash character, optionally wrapped in
// markdown emphasis: `— … —`, `*— … —*`, `_— … —_`.
const TRACKER_LINE = /^\s*[*_]{0,2}\s*[—–-]\s.*\s[—–-]\s*[*_]{0,2}\s*$/u;

function isTrackerParagraph(paragraph: string): boolean {
  const lines = paragraph.split("\n").filter((line) => !BLANK.test(line));
  return lines.length > 0 && lines.every((line) => TRACKER_LINE.test(line));
}

/** Split markdown-ish prose on blank lines without cutting inside a code fence. */
export function splitReadingGateParagraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined) out.push(joined);
    current = [];
  };
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && BLANK.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}

export function segmentForReadingGate(text: string): ReadingGateSegments {
  const paragraphs = splitReadingGateParagraphs(text);
  const tailParts: string[] = [];
  while (paragraphs.length > 1 && isTrackerParagraph(paragraphs[paragraphs.length - 1])) {
    tailParts.unshift(paragraphs.pop() as string);
  }
  return { paragraphs, tail: tailParts.join("\n\n") };
}

/** The markdown to render when `revealed` paragraphs are open; the tail rides with the last one. */
export function visibleReadingGateMarkdown(segments: ReadingGateSegments, revealed: number): string {
  const count = Math.max(0, Math.min(segments.paragraphs.length, revealed));
  const body = segments.paragraphs.slice(0, count).join("\n\n");
  if (count < segments.paragraphs.length || !segments.tail) return body;
  return body ? `${body}\n\n${segments.tail}` : segments.tail;
}

/** One reply, one swipe: the gate re-arms when either changes. */
export function readingGateKey(messageId: string, activeSwipeIndex: number | null | undefined): string {
  return `${messageId}:${activeSwipeIndex ?? 0}`;
}

/** Keys and durations are bounded so the persisted store cannot grow without limit. */
export const READING_GATE_HISTORY_LIMIT = 200;

export function appendBounded<T>(list: readonly T[], item: T, limit = READING_GATE_HISTORY_LIMIT): T[] {
  const next = [...list, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** True when the key event should advance the gate: plain Space / → / Enter outside any editable field. */
export function isReadingGateAdvanceKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== " " && event.key !== "ArrowRight" && event.key !== "Enter") return false;
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== "function") return true;
  return !target.closest(
    "input, textarea, select, button, a, [contenteditable=''], [contenteditable='true'], [role='dialog']",
  );
}
