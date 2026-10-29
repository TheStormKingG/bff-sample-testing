/**
 * Search and filter controls for the sample list.
 *
 * Dates are plant-local collection dates, so "24 October" means the Guyana
 * day the sample was taken. Free text is applied on submit rather than on
 * every keystroke: a plant tablet on a slow link should not fire a query per
 * character.
 */

import { useEffect, useId, useState } from 'react';
import { Search, X } from 'lucide-react';

import { DASHBOARD_ORDER } from '@/forms/registry';
import type { Stage } from '@/forms/types';
import { CAPTURE_STATES, CAPTURE_STATE_LABELS, type CaptureState } from '@/lib/workflow';
import {
  EMPTY_FILTERS,
  TESTING_STATUSES,
  TESTING_STATUS_LABELS,
  type SampleFilters as Filters,
  type TestingStatus,
} from '@/hooks/useSamples';
import { Button, INPUT_CLASS, Labelled } from './common';

export function SampleFilters({
  value,
  onChange,
  materials,
  materialsUnavailable,
}: {
  value: Filters;
  onChange: (next: Filters) => void;
  materials: readonly string[];
  /** True when the material list could not be read; the field says so. */
  materialsUnavailable?: boolean;
}) {
  const ids = useId();
  const [text, setText] = useState(value.text);

  // Keep the box in step when the filters are reset from outside.
  useEffect(() => setText(value.text), [value.text]);

  function toggleStage(stage: Stage) {
    const next = value.stages.includes(stage)
      ? value.stages.filter((s) => s !== stage)
      : [...value.stages, stage];
    onChange({ ...value, stages: next });
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ ...value, text });
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Labelled
            id={`${ids}-text`}
            label="Sample ID, batch, lot or run number"
            hint="Type part of the number and press Search."
          >
            <input
              id={`${ids}-text`}
              type="search"
              className={INPUT_CLASS}
              value={text}
              placeholder="RM-261024-01"
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${ids}-text-hint`}
            />
          </Labelled>
        </div>
        <Button type="submit" variant="primary">
          <Search aria-hidden className="h-4 w-4" />
          Search
        </Button>
        <Button
          onClick={() => {
            setText('');
            onChange(EMPTY_FILTERS);
          }}
        >
          <X aria-hidden className="h-4 w-4" />
          Clear all
        </Button>
      </div>

      <fieldset className="border-t border-slate-200 pt-3">
        <legend className="px-1 text-sm font-medium text-slate-800">Stage</legend>
        {/*
          The one place in the app where a Tailwind class was coupled to the
          stage count. `lg:grid-cols-7` left the eighth checkbox alone on a
          second row; `grid-cols-4` divides eight evenly and keeps dividing
          evenly if a ninth is ever added.
        */}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-4">
          {DASHBOARD_ORDER.map((schema) => {
            const id = `${ids}-stage-${schema.stage}`;
            const checked = value.stages.includes(schema.stage);
            return (
              <label
                key={schema.stage}
                htmlFor={id}
                className="flex min-h-tap cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-2 py-2 text-sm text-slate-800 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-bff-600"
              >
                <input
                  id={id}
                  type="checkbox"
                  className="h-5 w-5 rounded border-slate-400 text-bff-700 focus:ring-bff-600"
                  checked={checked}
                  onChange={() => toggleStage(schema.stage)}
                />
                <span>
                  {schema.ordinal}. {schema.title}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2 lg:grid-cols-3">
        <Labelled id={`${ids}-from`} label="Collected from (Guyana date)">
          <input
            id={`${ids}-from`}
            type="date"
            className={INPUT_CLASS}
            value={value.fromDate}
            onChange={(e) => onChange({ ...value, fromDate: e.target.value })}
          />
        </Labelled>

        <Labelled id={`${ids}-to`} label="Collected to (Guyana date)">
          <input
            id={`${ids}-to`}
            type="date"
            className={INPUT_CLASS}
            value={value.toDate}
            onChange={(e) => onChange({ ...value, toDate: e.target.value })}
          />
        </Labelled>

        <Labelled
          id={`${ids}-material`}
          label="Material"
          hint={
            materialsUnavailable
              ? 'The list of materials could not be read, so only a blank choice is offered.'
              : undefined
          }
        >
          <select
            id={`${ids}-material`}
            className={INPUT_CLASS}
            value={value.material}
            onChange={(e) => onChange({ ...value, material: e.target.value })}
          >
            <option value="">Any material</option>
            {materials.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled id={`${ids}-supplier`} label="Supplier">
          <input
            id={`${ids}-supplier`}
            type="text"
            className={INPUT_CLASS}
            value={value.supplier}
            onChange={(e) => onChange({ ...value, supplier: e.target.value })}
          />
        </Labelled>

        <Labelled id={`${ids}-capture`} label="Record state">
          <select
            id={`${ids}-capture`}
            className={INPUT_CLASS}
            value={value.captureStates[0] ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                captureStates: e.target.value === '' ? [] : [e.target.value as CaptureState],
              })
            }
          >
            <option value="">Any record state</option>
            {CAPTURE_STATES.map((s) => (
              <option key={s} value={s}>
                {CAPTURE_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled id={`${ids}-testing`} label="Testing status">
          <select
            id={`${ids}-testing`}
            className={INPUT_CLASS}
            value={value.testingStatus}
            onChange={(e) =>
              onChange({ ...value, testingStatus: e.target.value as TestingStatus })
            }
          >
            {TESTING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TESTING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Labelled>
      </div>

      <label
        htmlFor={`${ids}-hold`}
        className="flex min-h-tap w-fit cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-base text-slate-800 focus-within:ring-2 focus-within:ring-bff-600"
      >
        <input
          id={`${ids}-hold`}
          type="checkbox"
          className="h-5 w-5 rounded border-slate-400 text-bff-700 focus:ring-bff-600"
          checked={value.holdOnly}
          onChange={(e) => onChange({ ...value, holdOnly: e.target.checked })}
        />
        Only samples on quality hold
      </label>
    </form>
  );
}
