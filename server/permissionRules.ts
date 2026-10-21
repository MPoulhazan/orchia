import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Always allow": the allow rules a project keeps in `.claude/settings.local.json`,
 * the file Claude Code itself writes when you answer "Yes, and don't ask again".
 * Orchia adds rules through the PermissionRequest hook answer (so Claude Code
 * writes them), and lists and removes them here.
 */

/** A rule as Claude Code's permission updates spell it: `Bash` + `npm test:*`. */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/** A rule as the UI shows it: "Run" + `npm test *`. `rule` is the settings spelling. */
export interface RuleView {
  rule: string;
  verb: string;
  target: string;
}

/**
 * The allow rules Claude Code suggests for this request: what its own
 * "don't ask again" option would save. Empty when it suggests none (e.g. a mode change).
 */
export function suggestedRules(payload: any): PermissionRule[] {
  const suggestions = Array.isArray(payload?.permission_suggestions) ? payload.permission_suggestions : [];
  return suggestions
    .filter((s: any) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules))
    .flatMap((s: any) => s.rules)
    .filter((r: any) => typeof r?.toolName === 'string' && r.toolName)
    .map((r: any) => (typeof r.ruleContent === 'string' && r.ruleContent ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName }));
}

export const ruleString = (r: PermissionRule) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

function parseRule(rule: string): PermissionRule {
  const m = rule.match(/^([^(]+)\(([\s\S]*)\)$/);
  return m ? { toolName: m[1], ruleContent: m[2] } : { toolName: rule };
}

/** "Run" + `npm test *`, "Fetch" + `docs.github.com`, "Use" + `github: get_me`. */
export function describeRule(rule: PermissionRule): RuleView {
  const { toolName: tool, ruleContent: content } = rule;
  const view = (verb: string, target: string) => ({ rule: ruleString(rule), verb, target });
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return view('Run', content ? content.replace(/:\*$/, ' *') : 'any command');
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return view('Edit', content ?? 'any file');
    case 'Read':
    case 'Glob':
    case 'Grep':
      return view('Read', content ?? 'any file');
    case 'WebFetch':
      return view('Fetch', content ? content.replace(/^domain:/, '') : 'any page');
    case 'WebSearch':
      return view('Search', 'the web');
  }
  const mcp = tool.match(/^mcp__(.+?)(?:__(.+))?$/);
  if (mcp) return view('Use', `${mcp[1]}: ${mcp[2] ?? 'any tool'}`);
  return view('Use', content ? `${tool} ${content}` : tool);
}

const localSettingsFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

function readLocalSettings(cwd: string): any {
  const file = localSettingsFile(cwd);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** The project's own allow rules, in the order Claude Code saved them. */
export function projectAllowRules(cwd: string): RuleView[] {
  const allow = readLocalSettings(cwd)?.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string').map((r) => describeRule(parseRule(r))) : [];
}

/** Removes one allow rule, so Claude asks again for it. */
export function removeAllowRule(cwd: string, rule: string) {
  const file = localSettingsFile(cwd);
  if (!existsSync(file)) return;
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it by hand first.`);
  }
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(rule)) return;
  settings.permissions.allow = allow.filter((r: unknown) => r !== rule);
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
