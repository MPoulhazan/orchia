/**
 * The Up next prompt for a GitHub issue, on one line, shared by the issue picker and the
 * `orchia:go` label (server/issueLabels.ts). Claude reads the issue itself, comments included.
 * `-R` names the repository: the session may run in a folder that only holds it (`dir`).
 */
export function issuePrompt(issue: { number: number; title: string }, planFirst: boolean, repo: string, dir: string | null): string {
  const n = issue.number;
  const title = issue.title.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const read = `read it with gh issue view ${n} -R ${repo} --comments${dir ? `, the code is in the ${dir} folder` : ''}`;
  return planFirst
    ? `Work on GitHub issue #${n} "${title}": ${read}, then plan it in plan mode as numbered lots before changing anything. The last lot ends with a commit whose message ends with "Fixes #${n}".`
    : `Work on GitHub issue #${n} "${title}": ${read}, fix it and check that it works, then commit with a message that ends with "Fixes #${n}".`;
}

/** An Up next prompt made by issuePrompt, read back to show it short: "#12 Title". */
export function queuedIssue(text: string): { number: number; title: string; planFirst: boolean } | null {
  const m = text.match(/^Work on GitHub issue #(\d+) "(.*?)": read it with gh issue view \d+(?: -R \S+)? --comments, (?:the code is in the .*? folder, )?(then plan)?/);
  return m ? { number: Number(m[1]), title: m[2], planFirst: !!m[3] } : null;
}
