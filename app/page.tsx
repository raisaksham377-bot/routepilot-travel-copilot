'use client';

import { useMemo, useState } from 'react';
import { decide } from '@/lib/decision';
import type { Constraint } from '@/lib/schema/constraint';
import type { FlightOption } from '@/lib/schema/flightOption';
import type { PriorityRuleName, TripState } from '@/lib/schema/tripState';
import { ALL_SCENARIOS } from '@/lib/data/scenarios';
import { buildTripState } from '@/lib/data/build';
import { ConstraintLedger } from './components/ConstraintLedger';
import { NaturalLanguageInput } from './components/NaturalLanguageInput';
import { OptionForm } from './components/OptionForm';
import { OptionsPanel } from './components/OptionsPanel';
import { PriorityRulePicker } from './components/PriorityRulePicker';
import { ProvenanceBanner } from './components/ProvenanceBanner';
import { RecommendationPanel } from './components/RecommendationPanel';
import { BriefPanel } from './components/BriefPanel';

const EMPTY_STATE: TripState = buildTripState({ options: [], constraints: [] });

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rp-panel p-3">
      <header className="mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        {subtitle && (
          <p className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            {subtitle}
          </p>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * The trip workspace.
 *
 * This component imports the decision engine directly. There is no API route
 * for the decision, the ranking or the brief: with no AI features configured --
 * which is Checkpoint A in its entirety -- trip data never leaves the device,
 * not even to this app's own backend.
 *
 * Every panel derives from one TripState, so no two panels can disagree.
 */
export default function Page() {
  const [state, setState] = useState<TripState>(EMPTY_STATE);
  const [scenarioId, setScenarioId] = useState<string>('');

  const result = useMemo(() => decide(state), [state]);

  const loadScenario = (id: string) => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === id);
    setScenarioId(id);
    setState(scenario ? scenario.state : EMPTY_STATE);
  };

  const setPriorityRule = (priorityRule: PriorityRuleName) =>
    setState((prev) => ({ ...prev, priorityRule }));

  const addOption = (option: FlightOption) =>
    setState((prev) => ({
      ...prev,
      options: [...prev.options.filter((o) => o.id !== option.id), option],
    }));

  const removeOption = (id: string) =>
    setState((prev) => ({ ...prev, options: prev.options.filter((o) => o.id !== id) }));

  const changeConstraintKind = (index: number, kind: 'hard' | 'soft') =>
    setState((prev) => ({
      ...prev,
      constraints: prev.constraints.map((c, i) =>
        i === index ? { ...c, kind, source: 'user-edited' as const } : c,
      ),
    }));

  const removeConstraint = (index: number) =>
    setState((prev) => ({
      ...prev,
      constraints: prev.constraints.filter((_, i) => i !== index),
    }));

  /**
   * Commits an AI-proposed constraint, but only on an explicit user click.
   *
   * `source` becomes 'user-edited' at this point, not 'inferred': the user has
   * now taken ownership of the value, and the ledger should say so. The model's
   * suggestion only ever reached here as a proposal.
   */
  const acceptProposedConstraint = (constraint: Constraint, asKind: 'hard' | 'soft') =>
    setState((prev) => ({
      ...prev,
      constraints: [
        ...prev.constraints.filter((c) => c.key !== constraint.key),
        { ...constraint, kind: asKind, source: 'user-edited' } as Constraint,
      ],
    }));

  const activeScenario = ALL_SCENARIOS.find((s) => s.id === scenarioId);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">RoutePilot</h1>
        <p className="text-sm" style={{ color: 'var(--rp-muted)' }}>
          A constraint-led travel decision workspace that shows its reasoning. Checkpoint A:
          deterministic engine and structured manual entry. No voice, no paste parsing, no AI, no
          network.
        </p>
      </header>

      <ProvenanceBanner provenances={state.options.map((o) => o.provenance)} />

      <Panel
        title="Scenario"
        subtitle="Nine seeded scenarios, each a golden test of the engine. All sample data."
      >
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="rp-btn-secondary"
            aria-pressed={scenarioId === ''}
            onClick={() => loadScenario('')}
          >
            Empty
          </button>
          {ALL_SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="rp-btn-secondary"
              aria-pressed={scenarioId === s.id}
              onClick={() => loadScenario(s.id)}
              title={s.title}
            >
              {s.id}
              {s.usesRewardsModule && ' ◆'}
            </button>
          ))}
        </div>
        {activeScenario && (
          <div className="mt-2 text-sm">
            <p className="font-medium">{activeScenario.title}</p>
            <p className="text-[12px]" style={{ color: 'var(--rp-muted)' }}>
              {activeScenario.expectation}
            </p>
            {activeScenario.usesRewardsModule && (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                ◆ Uses the optional rewards module. The other eight scenarios work with it off.
              </p>
            )}
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Constraints"
          subtitle="Firm requirements exclude. Preferences inform ranking. Both are editable."
        >
          <ConstraintLedger
            constraints={state.constraints}
            onChangeKind={changeConstraintKind}
            onRemove={removeConstraint}
          />
        </Panel>

        <Panel title="What matters most" subtitle="Choose the priority; the ranking follows it.">
          <PriorityRulePicker value={state.priorityRule} onChange={setPriorityRule} />
        </Panel>
      </div>

      <Panel
        title="Options"
        subtitle="Each measure is shown separately. There is no blended score."
      >
        <OptionsPanel result={result} onRemove={removeOption} />
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Recommendation" subtitle="With the reasoning, the risks and a fallback.">
          <RecommendationPanel result={result} />
        </Panel>

        <Panel title="Executive brief" subtitle="Rendered on this device. Nothing is uploaded.">
          <BriefPanel state={state} result={result} />
        </Panel>
      </div>

      <Panel
        title="Describe the trip (AI, optional)"
        subtitle="Typed natural language. Explicit action only, after a disclosure. Returns proposals you confirm — nothing is applied automatically."
      >
        <NaturalLanguageInput
          constraints={state.constraints}
          onAccept={acceptProposedConstraint}
        />
      </Panel>

      <Panel
        title="Add an option by hand"
        subtitle="The baseline real-data path. Needs no API key and makes no network request. Use non-sensitive or synthetic details only."
      >
        <OptionForm asOf={state.asOf} onAdd={addOption} />
      </Panel>
    </main>
  );
}
