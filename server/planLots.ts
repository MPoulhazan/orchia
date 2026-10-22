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

/** What Claude gets approved instead of the whole plan: the plan, then the instruction to do lot 1 only. */
export function firstLotPlan(plan: string, lots: string[]): string {
  return (
    `${plan.trimEnd()}\n\n---\n\n` +
    `The user split this plan into ${lots.length} lots and will send the next ones one at a time. ` +
    `Do lot 1 only now, then stop and wait:\n\n${lots[0]}`
  );
}

/** The Up next prompt for a later lot, on one line (Claude Code submits at a line break). */
export function lotPrompt(lot: string, n: number, total: number): string {
  let text = lot.replace(/^#+\s+/gm, '').replace(/\s*\n\s*/g, ' ').trim();
  if (text.length > MAX_LOT_CHARS) text = `${text.slice(0, MAX_LOT_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  return `Continue the plan with lot ${n} of ${total} only, then stop: ${text}`;
}
