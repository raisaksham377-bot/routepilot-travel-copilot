import { PROVENANCE_DESCRIPTIONS, PROVENANCE_LABELS, type Provenance } from '@/lib/schema/provenance';

/**
 * Non-dismissible, by design.
 *
 * A brief that looks authoritative while resting on fixture data is the main
 * way this project could mislead someone, so the statement that nothing was
 * fetched live is a correctness requirement rather than a disclaimer.
 */
export function ProvenanceBanner({ provenances }: { provenances: Provenance[] }) {
  const kinds = [...new Set(provenances)].sort();
  return (
    <div
      className="rounded-lg px-3 py-2 text-sm"
      style={{
        background: 'var(--rp-warn-bg)',
        border: '1px solid var(--rp-warn-border)',
      }}
      role="note"
    >
      <strong>Nothing here was fetched live.</strong> Prices and availability were not retrieved or
      verified by this application, and nothing is bookable. Enter only non-sensitive or synthetic
      details — this is a demonstration, not a booking tool.
      {kinds.length > 0 && (
        <ul className="mt-1 list-disc pl-5" style={{ color: 'var(--rp-muted)' }}>
          {kinds.map((k) => (
            <li key={k}>
              <span className="font-medium">{PROVENANCE_LABELS[k]}</span> — {PROVENANCE_DESCRIPTIONS[k]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const isSample = provenance === 'SAMPLE';
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        background: isSample ? 'var(--rp-warn-bg)' : 'transparent',
        border: `1px solid ${isSample ? 'var(--rp-warn-border)' : 'var(--rp-border)'}`,
        color: 'var(--rp-muted)',
      }}
      title={PROVENANCE_DESCRIPTIONS[provenance]}
    >
      {PROVENANCE_LABELS[provenance]}
    </span>
  );
}
