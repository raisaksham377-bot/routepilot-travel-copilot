'use client';

import { useState } from 'react';
import { CABIN_ORDER, CABIN_LABELS, type FlightOption } from '@/lib/schema/flightOption';
import {
  COMMON_ZONES,
  emptyLeg,
  emptyOptionForm,
  formToOption,
  type OptionFormValues,
} from '../lib/formToOption';

/**
 * Structured manual entry.
 *
 * This is the baseline real-data path for Checkpoint A: the assistant has
 * options open in browser tabs and types them in. It needs no API key and makes
 * no network request -- everything stays on the device.
 *
 * A wall-clock time plus an IANA zone is collected for each end of each flight,
 * rather than a bare time, because a bare time cannot be resolved into a real
 * moment and this engine refuses to guess one.
 */
export function OptionForm({
  asOf,
  onAdd,
}: {
  asOf: string;
  onAdd: (option: FlightOption) => void;
}) {
  const [values, setValues] = useState<OptionFormValues>(emptyOptionForm());
  const [errors, setErrors] = useState<string[]>([]);

  const set = <K extends keyof OptionFormValues>(key: K, v: OptionFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const setLeg = (index: number, patch: Partial<OptionFormValues['legs'][number]>) =>
    setValues((prev) => ({
      ...prev,
      legs: prev.legs.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));

  const submit = () => {
    const conversion = formToOption(values, asOf);
    if (!conversion.ok) {
      setErrors(conversion.errors);
      return;
    }
    setErrors([]);
    onAdd(conversion.option);
    setValues(emptyOptionForm());
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Label
          </span>
          <input
            className="rp-input"
            value={values.id}
            onChange={(e) => set('id', e.target.value)}
            placeholder="BA117"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Carrier
          </span>
          <input
            className="rp-input"
            value={values.carrier}
            onChange={(e) => set('carrier', e.target.value)}
            placeholder="British Airways"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Cabin
          </span>
          <select
            className="rp-input"
            value={values.cabin}
            onChange={(e) => set('cabin', e.target.value as OptionFormValues['cabin'])}
          >
            {CABIN_ORDER.map((c) => (
              <option key={c} value={c}>
                {CABIN_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Paid with
          </span>
          <select
            className="rp-input"
            value={values.paymentKind}
            onChange={(e) => set('paymentKind', e.target.value as 'cash' | 'award')}
          >
            <option value="cash">Cash</option>
            <option value="award">Points / award</option>
          </select>
        </label>
      </div>

      {values.legs.map((leg, i) => (
        <fieldset
          key={i}
          className="flex flex-col gap-2 rounded-md p-2"
          style={{ border: '1px solid var(--rp-border)' }}
        >
          <legend className="px-1 text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Flight {i + 1}
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <input
              className="rp-input"
              value={leg.flightNumber}
              onChange={(e) => setLeg(i, { flightNumber: e.target.value })}
              placeholder="Flight no."
            />
            <input
              className="rp-input"
              value={leg.origin}
              onChange={(e) => setLeg(i, { origin: e.target.value })
              }
              placeholder="From (LHR)"
              maxLength={3}
            />
            <input
              className="rp-input"
              value={leg.destination}
              onChange={(e) => setLeg(i, { destination: e.target.value })}
              placeholder="To (JFK)"
              maxLength={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                Departs (local)
              </span>
              <input
                type="datetime-local"
                className="rp-input"
                value={leg.departureLocal}
                onChange={(e) => setLeg(i, { departureLocal: e.target.value })}
              />
              <select
                className="rp-input"
                value={leg.departureTz}
                onChange={(e) => setLeg(i, { departureTz: e.target.value })}
              >
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                Arrives (local)
              </span>
              <input
                type="datetime-local"
                className="rp-input"
                value={leg.arrivalLocal}
                onChange={(e) => setLeg(i, { arrivalLocal: e.target.value })}
              />
              <select
                className="rp-input"
                value={leg.arrivalTz}
                onChange={(e) => setLeg(i, { arrivalTz: e.target.value })}
              >
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rp-btn-secondary"
          onClick={() => setValues((p) => ({ ...p, legs: [...p.legs, emptyLeg()] }))}
        >
          + Add a connecting flight
        </button>
        {values.legs.length > 1 && (
          <button
            type="button"
            className="rp-btn-secondary"
            onClick={() => setValues((p) => ({ ...p, legs: p.legs.slice(0, -1) }))}
          >
            − Remove last flight
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {values.paymentKind === 'cash' ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
              Cash ticket total
            </span>
            <input
              className="rp-input"
              value={values.comparableCashTicketTotal}
              onChange={(e) => set('comparableCashTicketTotal', e.target.value)}
              placeholder="1105"
            />
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                Cash still payable
              </span>
              <input
                className="rp-input"
                value={values.awardCashCoPayment}
                onChange={(e) => set('awardCashCoPayment', e.target.value)}
                placeholder="1150"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
                Points required
              </span>
              <input
                className="rp-input"
                value={values.pointsRequired}
                onChange={(e) => set('pointsRequired', e.target.value)}
                placeholder="120000"
              />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--rp-muted)' }}>
            Taxes & fees
          </span>
          <input
            className="rp-input"
            value={values.taxesAndFees}
            onChange={(e) => set('taxesAndFees', e.target.value)}
            placeholder="240"
          />
        </label>
      </div>

      {errors.length > 0 && (
        <ul
          className="list-disc rounded-md px-5 py-2 text-[13px]"
          style={{
            background: 'var(--rp-excluded-bg)',
            border: '1px solid var(--rp-excluded-border)',
          }}
        >
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div>
        <button type="button" className="rp-btn" onClick={submit}>
          Add this option
        </button>
      </div>
    </div>
  );
}
