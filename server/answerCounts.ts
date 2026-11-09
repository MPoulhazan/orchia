import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';

/**
 * How many permission requests were answered from the phone and from Orchia on this computer,
 * to tell whether Needs you on your phone is used at all. Kept on this computer, never sent.
 */

export type AnswerSource = 'phone' | 'computer';
export type AnswerTotals = Record<AnswerSource, number>;

const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0);

export class AnswerCounts {
  private totals: AnswerTotals = { phone: 0, computer: 0 };

  constructor(private file = join(CONFIG_DIR, 'answer-counts.json')) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.totals = { phone: count(saved?.phone), computer: count(saved?.computer) };
    } catch {}
  }

  get(): AnswerTotals {
    return this.totals;
  }

  add(source: AnswerSource) {
    this.totals = { ...this.totals, [source]: this.totals[source] + 1 };
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.totals));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error(`Could not save ${this.file}:`, err);
    }
  }
}
