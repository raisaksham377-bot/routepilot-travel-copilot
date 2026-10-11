'use client';

import { useMemo, useState } from 'react';
import type { TripState } from '@/lib/schema/tripState';
import type { DecisionResult } from '@/lib/decision/types';
import { renderBrief } from '@/lib/brief/render';

/**
 * The exportable brief.
 *
 * Rendered in the browser from the trace. Generating or copying it posts
 * nothing to any server -- there is no /api/brief route, deliberately.
 */
export function BriefPanel({ state, result }: { state: TripState; result: DecisionResult }) {
  const [copied, setCopied] = useState(false);
  const markdown = useMemo(() => renderBrief(state, result), [state, result]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the textarea below is the fallback.
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rp-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
        <button type="button" className="rp-btn-secondary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
      </div>
      <textarea
        readOnly
        value={markdown}
        rows={18}
        className="rp-input rp-mono"
        style={{ fontSize: '12px', lineHeight: 1.5 }}
        aria-label="Executive brief as Markdown"
      />
    </div>
  );
}
