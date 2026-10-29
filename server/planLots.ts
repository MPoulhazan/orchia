/**
 * "Split into Up next": cuts a plan Claude presents for review (ExitPlanMode) into lots,
 * from the plan's own structure. No model call. The first lot replaces the plan Claude
 * gets approved; the others go to the Up next queue, one prompt each.
 */

const MAX_LOTS = 12;
const MAX_LOT_CHARS = 600;
/** "Lot 2", "Phase 1:", "Step 3 —", "2.", "2)": headings or items that number the work. */
const LOT_TITLE = /^(?:(?:lot|phase|step|stage|part|milestone|étape)\s*\d+\b|\d+[.):]\s)/i;
const HEADING = /^(#{2,4})\s+(.*\S)\s*$/;
const TOP_ITEM = /^(\d+)[.)]\s+\S/;

/** The plan's lots as Markdown, in order; null when it has no clear structure to cut along. */
export function splitPlan(plan: unknown): string[] | null {
  if (typeof plan !== 'string') return null;
  const lines = plan.replace(/\r\n/g, '\n').split('\n');
  const lots = byHeadings(lines) ?? byNumberedItems(lines);
  return lots && lots.length >= 2 && lots.length <= MAX_LOTS ? lots : null;
}

/** A heading or a bold line that starts with "Lot 2", "Phase 2", "Step 2"…: a lot title in an ordinary answer. */
const ANSWER_LOT = /^(?:#{2,4}\s+|\*\*)(?:lot|phase|step|stage|étape)\s*\d+\b/i;

/**
 * The lots of an ordinary answer (not a plan Claude presents for review), or null. Stricter
 * than splitPlan: only titled lots count, never a plain numbered list, so a summary of what
 * was done ("1. Fixed X 2. Fixed Y") doesn't read as a plan. Each lot runs to the next title.
 */
export function splitAnswer(answer: unknown): string[] | null {
  if (typeof answer !== 'string') return null;
  const lines = answer.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((l, i) => (ANSWER_LOT.test(l.trim()) ? [i] : []));
  if (starts.length < 2 || starts.length > MAX_LOTS) return null;
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    // The last lot stops at a rule or a heading of its level or above, before any closing remarks.
    if (n + 1 === starts.length) {
      const level = lines[start].trim().match(/^#+/)?.[0].length ?? 6;
      for (let i = start + 1; i < lines.length; i++) {
        const heading = lines[i].match(/^(#{1,6})\s/);
        if (/^---\s*$/.test(lines[i]) || (heading && heading[1].length <= level)) {
          end = i;
          break;
        }
      }
    }
    return lines.slice(start, end).join('\n').trim();
  });
}

/** Headings of one level that number the work ("### Lot 2: API"); a lot runs to the next heading at that level or above. */
function byHeadings(lines: string[]): string[] | null {
  const headings = lines.map((l, i) => ({ i, m: l.match(HEADING) })).filter((h) => h.m && LOT_TITLE.test(h.m[2]));
  if (headings.length < 2) return null;
  const level = Math.min(...headings.map((h) => h.m![1].length));
  const starts = headings.filter((h) => h.m![1].length === level).map((h) => h.i);
  if (starts.length < 2) return null;
  return starts.map((start, n) => {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(HEADING);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    if (n + 1 < starts.length) end = Math.min(end, starts[n + 1]);
    return lines.slice(start, end).join('\n').trim();
  });
}

/** A numbered list at the left margin, the longest one in the plan; each item takes its indented lines. */
function byNumberedItems(lines: string[]): string[] | null {
  let best: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > best.length) best = current;
    current = [];
  };
  for (const line of lines) {
    if (TOP_ITEM.test(line)) current.push(line);
    else if (current.length && (/^\s+\S/.test(line) || !line.trim())) current[current.length - 1] += `\n${line}`;
    else flush();
  }
  flush();
  return best.length >= 2 ? best.map((item) => item.trim()) : null;
}

/**
 * How a run of lots goes. `clear`: a fresh conversation for each lot after the first, which
 * then gets the whole plan in its prompt; it needs `commit`, so the work done is in git.
 */
export interface LotOptions {
  clear: boolean;
  commit: boolean;
}

export const DEFAULT_LOT_OPTIONS: LotOptions = { clear: false, commit: true };

/** A cleared lot's prompt carries the whole plan, cut past this many characters. */
const MAX_PLAN_CHARS = 6000;

/** What Claude gets approved instead of the whole plan: the plan, then the instruction to do lot 1 only. */
export function firstLotPlan(plan: string, lots: string[], options = DEFAULT_LOT_OPTIONS): string {
  return (
    `${plan.trimEnd()}\n\n---\n\n` +
    `The user split this plan into ${lots.length} lots and will send the next ones one at a time. ` +
    `Do lot 1 only now, then stop and wait:\n\n${lots[0]}\n\n${lotRules(1, options.commit)}`
  );
}

/**
 * The Up next prompt for a lot, on one line (Claude Code submits at a line break). After a
 * /clear, Claude has forgotten the plan: the prompt then carries all of it, uncut.
 */
export function lotPrompt(lot: string, n: number, lots: string[], options = DEFAULT_LOT_OPTIONS): string {
  const total = lots.length;
  const rules = lotRules(n, options.commit);
  if (options.clear && n > 1) {
    const done = n === 2 ? 'Lot 1 is done' : `Lots 1 to ${n - 1} are done`;
    return (
      `You are running a plan in ${total} lots, one at a time. ${done} and committed: see git log for what changed. ` +
      `Do lot ${n} only, then stop. The whole plan: ${cut(oneLine(lots.join('\n')), MAX_PLAN_CHARS)} Lot ${n} is: ${oneLine(lot)} ${rules}`
    );
  }
  return `Continue the plan with lot ${n} of ${total} only, then stop: ${cut(oneLine(lot), MAX_LOT_CHARS)} ${rules}`;
}

function oneLine(markdown: string): string {
  return markdown.replace(/^#+\s+/gm, '').replace(/\*\*/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
}

/** How a lot must end, so the next one only goes when this one is really done. One line. */
function lotRules(n: number, commit: boolean): string {
  const then = commit ? 'commit it if this is a git repository, then end' : 'end';
  return (
    `When lot ${n} is finished and checked, ${then} your reply with the line "LOT ${n} DONE". ` +
    `If you can't finish it, a check fails or you need a decision from the user, stop and end with "LOT ${n} BLOCKED: <reason>".`
  );
}

/**
 * How a lot ended, from Claude's last reply: null when it says `LOT n DONE`, else why it
 * didn't (the reason after `LOT n BLOCKED:`, or '' when the reply has no marker at all).
 * Only the end of the reply counts, where the rules ask for the marker.
 */
export function lotNotDone(reply: unknown, n: number): string | null {
  const end = typeof reply === 'string' ? reply.trimEnd().slice(-400) : '';
  const blocked = end.match(new RegExp(`\\bLOT ${n} BLOCKED\\b\\W*(.*)`, 'i'));
  if (blocked) return blocked[1].trim().slice(0, 200);
  return new RegExp(`\\bLOT ${n} DONE\\b`, 'i').test(end) ? null : '';
}
