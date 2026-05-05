"use client";

import { useState } from "react";

export type BuildSettingsValues = {
  cluster_eps_meters: number;
  cluster_min_size: number;
  min_zone_size: number;
  min_stops: number;
  max_stops: number;
  target_stops: number;
  show_zones: boolean;
};

export const DEFAULT_BUILD_SETTINGS: BuildSettingsValues = {
  cluster_eps_meters: 500,
  cluster_min_size: 2,
  min_zone_size: 25,
  min_stops: 45,
  max_stops: 75,
  target_stops: 60,
  show_zones: true,
};

type Props = {
  values: BuildSettingsValues;
  onChange: (next: BuildSettingsValues) => void;
};

export default function BuildSettings({ values, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const set = <K extends keyof BuildSettingsValues>(key: K, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange({ ...values, [key]: n });
  };

  return (
    <div className="border-b hairline bg-paper">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-6 py-2"
      >
        <span className="label">
          Build settings · cluster gap {values.cluster_eps_meters}m · stops{" "}
          {values.min_stops}–{values.max_stops}
        </span>
        <span className="label">{open ? "Hide ▾" : "Show ▸"}</span>
      </button>
      {open && (
        <div className="px-6 pb-3 grid grid-cols-2 md:grid-cols-5 gap-3">
          <Field
            label="Cluster gap (m)"
            hint="Split into separate routes when leads are farther apart than this"
            value={values.cluster_eps_meters}
            min={0}
            step={50}
            onChange={(v) => set("cluster_eps_meters", v)}
          />
          <Field
            label="Min cluster size (routing)"
            hint="Smaller clusters merge into the nearest neighbor for route building"
            value={values.cluster_min_size}
            min={1}
            step={1}
            onChange={(v) => set("cluster_min_size", v)}
          />
          <Field
            label="Min zone size (visual)"
            hint="Hide zone outlines for clusters smaller than this — stragglers stay unrendered"
            value={values.min_zone_size}
            min={1}
            step={1}
            onChange={(v) => set("min_zone_size", v)}
          />
          <Field
            label="Min stops / route"
            value={values.min_stops}
            min={1}
            step={1}
            onChange={(v) => set("min_stops", v)}
          />
          <Field
            label="Max stops / route"
            value={values.max_stops}
            min={1}
            step={1}
            onChange={(v) => set("max_stops", v)}
          />
          <Field
            label="Target stops / route"
            value={values.target_stops}
            min={1}
            step={1}
            onChange={(v) => set("target_stops", v)}
          />
          <label className="flex items-center gap-2 self-end col-span-2 md:col-span-1">
            <input
              type="checkbox"
              checked={values.show_zones}
              onChange={(e) => onChange({ ...values, show_zones: e.target.checked })}
            />
            <span className="label">Show zone outlines</span>
          </label>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_BUILD_SETTINGS)}
            className="label px-3 py-2 border hairline hover:bg-black/5 col-span-2 md:col-span-1 self-end"
          >
            Reset defaults
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  min,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  step?: number;
  onChange: (raw: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm border hairline rounded px-2 py-1 bg-white tabular-nums"
      />
      {hint && <span className="text-[11px] text-black/55 leading-tight">{hint}</span>}
    </label>
  );
}
