"use client";

import { useState } from "react";

export interface ExceptionOption<T extends string> {
  value: T;
  text: string;
  /** "alert" = static color change. "urgent" = animated, live penalty risk. */
  severity: "alert" | "urgent";
}

/**
 * Booth control pattern for exception-only fields (Personnel, Splits):
 * assumed clean by default with no tap required, a small button reveals
 * the alert options, and picking one — or tapping Clear — collapses it
 * again. Keeps rarely-needed controls from cluttering the booth screen.
 */
export function ExceptionToggle<T extends string>({
  label,
  value,
  defaultValue,
  defaultText,
  flagText,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  value: T;
  defaultValue: T;
  defaultText: string;
  flagText: string;
  options: ExceptionOption<T>[];
  onSelect: (v: T) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDefault = value === defaultValue;

  // Collapse if the value was reset back to default from outside (e.g. the
  // per-play auto-reset after a Result logs) — a render-time state
  // adjustment rather than an effect, per React's guidance for syncing
  // state to a prop change.
  const [prevIsDefault, setPrevIsDefault] = useState(isDefault);
  if (isDefault !== prevIsDefault) {
    setPrevIsDefault(isDefault);
    if (isDefault) setExpanded(false);
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </p>

      {!expanded && isDefault && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setExpanded(true)}
          className="rounded-xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-300 active:bg-slate-700 disabled:opacity-50"
        >
          {flagText}
        </button>
      )}

      {!expanded && !isDefault && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setExpanded(true)}
          className={[
            "w-full rounded-2xl px-4 py-6 text-xl font-bold",
            options.find((o) => o.value === value)?.severity === "urgent"
              ? "animate-pulse bg-red-500 text-red-950"
              : "bg-amber-400 text-amber-950",
          ].join(" ")}
        >
          {options.find((o) => o.value === value)?.text ?? String(value)}
        </button>
      )}

      {expanded && (
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSelect(defaultValue);
              setExpanded(false);
            }}
            className="rounded-xl bg-emerald-500 px-2 py-4 text-sm font-bold text-emerald-950 active:bg-emerald-600 disabled:opacity-50"
          >
            {defaultText}
          </button>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => {
                onSelect(opt.value);
                setExpanded(false);
              }}
              className={[
                "rounded-xl px-2 py-4 text-sm font-bold disabled:opacity-50",
                opt.severity === "urgent"
                  ? "bg-red-500 text-red-950 active:bg-red-600"
                  : "bg-amber-400 text-amber-950 active:bg-amber-500",
              ].join(" ")}
            >
              {opt.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
