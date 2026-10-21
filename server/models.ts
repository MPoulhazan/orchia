import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Aliases accepted by `claude --model`; they resolve to the latest version of each family. */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function isModelAlias(value: unknown): value is (typeof MODEL_ALIASES)[number] {
  return MODEL_ALIASES.includes(value as any);
}

export function isEffortLevel(value: unknown): value is (typeof EFFORT_LEVELS)[number] {
  return EFFORT_LEVELS.includes(value as any);
}

const CHUNK_BYTES = 256 * 1024;
const SCAN_LIMIT = 4 * 1024 * 1024;

// Stop fires before Claude Code has flushed the reply to the transcript.
const TRANSCRIPT_FLUSH_DELAY = 1500;
const TITLE_LATE_DELAY = 10_000;

/**
 * Reports the model that actually answered: PostModelSwitch names it directly,
 * Stop points at the transcript whose last reply records it.
 */
export function watchModel(payload: any, onModel: (model: string) => void) {
  if (payload?.hook_event_name === 'PostModelSwitch' && typeof payload.to_model === 'string') {
    onModel(payload.to_model);
  } else if (payload?.hook_event_name === 'Stop' && typeof payload.transcript_path === 'string') {
    const file = payload.transcript_path;
    setTimeout(() => {
      // Synthetic messages (errors, interruptions) use non-claude placeholders; skip them.
      const model = lastInTranscript(file, /"model":"(claude-[^"]+)"/g);
      if (model) onModel(model);
    }, TRANSCRIPT_FLUSH_DELAY);
  }
}

/**
 * Reports the title Claude Code gives the conversation (the one `/resume` lists). It writes
 * it to the transcript as `ai-title` lines, a little after the first prompt and again later.
 */
export function watchTitle(payload: any, onTitle: (title: string) => void) {
  if (payload?.hook_event_name !== 'Stop' || typeof payload.transcript_path !== 'string') return;
  const file = payload.transcript_path;
  const read = () => {
    const raw = lastInTranscript(file, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
    if (!raw) return;
    try {
      onTitle(JSON.parse(`"${raw}"`));
    } catch {}
  };
  setTimeout(read, TRANSCRIPT_FLUSH_DELAY);
  // The title is made in the background and can land after a short first turn.
  setTimeout(read, TITLE_LATE_DELAY);
}

/**
 * Scans the transcript backwards in chunks: lines written after a reply (tool
 * results, attachments) can be hundreds of KB, and transcripts reach many MB.
 */
function lastInTranscript(file: string, pattern: RegExp): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    let end = size;
    let carry = ''; // start of the previous chunk, in case a match straddles the boundary
    while (end > 0 && size - end < SCAN_LIMIT) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8') + carry;
      const matches = [...text.matchAll(pattern)];
      if (matches.length) return matches.at(-1)![1];
      carry = text.slice(0, 256);
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
