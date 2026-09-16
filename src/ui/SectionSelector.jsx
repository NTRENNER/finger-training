import React from "react";
import { C } from "./theme.js";
import "./SectionSelector.css";

// Shared full-width navigation for Analysis and History.
export function SectionSelector({ label, options, value, onChange }) {
  return (
    <div className="section-selector" role="group" aria-label={label}
      style={{ "--section-count": options.length }}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key}
          onClick={() => onChange(key)}
          style={{ background: value === key ? C.blue : C.bg,
            color: value === key ? "#fff" : C.text,
            borderColor: value === key ? C.blue : C.border }}>
          {text}
        </button>
      ))}
    </div>
  );
}
