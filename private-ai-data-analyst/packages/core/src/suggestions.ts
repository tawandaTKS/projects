import type { TableInfo } from './types';
import { isNumericType, isTemporalType } from './values';

const MONEY = /(amount|revenue|sales|total|price|cost|salary|pay|spend|expense|balance|fee|charge|value|income|profit)/i;

/** Starter questions derived from the schema — no model call needed. */
export function suggestQuestions(tables: TableInfo[], limit = 4): string[] {
  const out: string[] = [];
  for (const t of tables) {
    const nums = t.columns.filter((c) => isNumericType(c.type) && !/(^id$|_id$|^id_|zip|postcode|phone|year)/i.test(c.name));
    const metric = nums.find((c) => MONEY.test(c.name)) ?? nums[0];
    const date = t.columns.find((c) => isTemporalType(c.type));
    const cat = t.columns.find((c) => c.values && c.values.length >= 2 && c.values.length <= 25);
    const label = t.name.replace(/_/g, ' ');
    if (metric && cat) out.push(`What is the total ${metric.name} by ${cat.name}?`);
    if (metric && date) out.push(`Show ${metric.name} by month`);
    if (cat) out.push(`How many ${label} records are there for each ${cat.name}?`);
    if (metric) out.push(`What are the top 10 rows by ${metric.name}?`);
    if (nums.length >= 2) out.push(`Is there a relationship between ${nums[0].name} and ${nums[1].name}?`);
    out.push(`Summarise the ${label} data: row count, key columns and anything unusual`);
  }
  return [...new Set(out)].slice(0, limit);
}
