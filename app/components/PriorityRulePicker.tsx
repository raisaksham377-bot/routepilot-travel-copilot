'use client';

import {
  PRIORITY_RULE_EXPLANATIONS,
  PRIORITY_RULE_LABELS,
  priorityRuleSchema,
  type PriorityRuleName,
} from '@/lib/schema/tripState';
import { PRIORITY_RULES } from '@/lib/decision/priority';

/**
 * The explicit priority rule.
 *
 * The user chooses what matters and the ranking follows a documented comparator
 * sequence -- no weights to tune and no hidden exchange rate between time and
 * money. The sequence is shown so the ordering is inspectable before any
 * result is read.
 *
 * Note the deliberate absence of any claim about punctuality: these rules sort
 * on itinerary characteristics and the engine holds no historical performance
 * data.
 */
export function PriorityRulePicker({
  value,
  onChange,
}: {
  value: PriorityRuleName;
  onChange: (rule: PriorityRuleName) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {priorityRuleSchema.options.map((rule) => (
          <button
            key={rule}
            type="button"
            className="rp-btn-secondary"
            aria-pressed={value === rule}
            onClick={() => onChange(rule)}
          >
            {PRIORITY_RULE_LABELS[rule]}
          </button>
        ))}
      </div>

      <p className="text-sm" style={{ color: 'var(--rp-muted)' }}>
        {PRIORITY_RULE_EXPLANATIONS[value]}
      </p>

      <p className="text-[11px] rp-mono" style={{ color: 'var(--rp-muted)' }}>
        order:{' '}
        {PRIORITY_RULES[value].map((c, i) => (
          <span key={c.measure}>
            {i > 0 && ' → '}
            {c.measure} {c.direction}
          </span>
        ))}
      </p>
    </div>
  );
}
