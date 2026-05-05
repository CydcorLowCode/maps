"use client";

import { useState } from "react";
import { useIclCode } from "@/lib/iclCode";

export default function IclSelector() {
  const { iclCode, setIclCode, resetIclCode, defaultIclCode } = useIclCode();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(iclCode);

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <div className="label">ICL · {iclCode}</div>
        <button
          onClick={() => {
            setDraft(iclCode);
            setEditing(true);
          }}
          className="label underline underline-offset-4 hover:text-[var(--ink)]"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setIclCode(draft);
        setEditing(false);
      }}
      className="flex items-center gap-2"
    >
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="border hairline px-2 py-1 text-sm uppercase tracking-wider w-32"
        placeholder="ICL"
      />
      <button
        type="submit"
        className="label px-2 py-1 border hairline hover:bg-black/5"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          resetIclCode();
          setDraft(defaultIclCode);
          setEditing(false);
        }}
        className="label hover:text-[var(--ink)]"
      >
        Reset
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="label hover:text-[var(--ink)]"
      >
        Cancel
      </button>
    </form>
  );
}
