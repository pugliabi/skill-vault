import { type CSSProperties, useCallback, useEffect, useRef } from "react";

/**
 * Shared selection behavior for the app's checklists (Adopt, Discover, Sync,
 * PushDrawer). Provides:
 *
 *  - Select all / Deselect all (via {@link SelectAllControl}).
 *  - Ctrl/Cmd-click to toggle a single item without disturbing the rest.
 *  - Shift-click to extend (or contract) a contiguous range from the last
 *    clicked anchor, matching the anchor's selected state — Explorer-style.
 *
 * The owning component keeps the `Set<string>` of picked keys in its own state;
 * this hook only layers click semantics and an anchor on top of it.
 */
export interface ModifierClick {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface ChecklistSelection {
  /** True when every selectable key is currently picked. */
  allSelected: boolean;
  /** True when at least one (but maybe not all) key is picked. */
  someSelected: boolean;
  selectAll: () => void;
  deselectAll: () => void;
  /** Handle a click on a row/checkbox, honoring Shift + Ctrl/Cmd modifiers. */
  onItemClick: (key: string, e: ModifierClick) => void;
}

export function useChecklistSelection(
  /** Ordered list of selectable keys, in render order (drives range select). */
  keys: string[],
  picked: Set<string>,
  setPicked: (next: Set<string>) => void,
): ChecklistSelection {
  const anchorRef = useRef<string | null>(null);

  const selectAll = useCallback(() => setPicked(new Set(keys)), [keys, setPicked]);
  const deselectAll = useCallback(() => setPicked(new Set()), [setPicked]);

  const onItemClick = useCallback(
    (key: string, e: ModifierClick) => {
      const anchor = anchorRef.current;

      // Shift-click: extend the range from the anchor to this item, applying
      // the anchor's current state across the whole span.
      if (e.shiftKey && anchor && anchor !== key) {
        const a = keys.indexOf(anchor);
        const b = keys.indexOf(key);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const add = picked.has(anchor);
          const next = new Set(picked);
          for (let i = lo; i <= hi; i++) {
            if (add) next.add(keys[i]);
            else next.delete(keys[i]);
          }
          setPicked(next);
          anchorRef.current = key;
          return;
        }
      }

      // Plain or Ctrl/Cmd click: toggle just this item.
      const next = new Set(picked);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setPicked(next);
      anchorRef.current = key;
    },
    [keys, picked, setPicked],
  );

  const allSelected = keys.length > 0 && keys.every((k) => picked.has(k));
  const someSelected = keys.some((k) => picked.has(k));

  return { allSelected, someSelected, selectAll, deselectAll, onItemClick };
}

/**
 * Compact "Select all / Deselect all" control with a tri-state master checkbox.
 * Indeterminate when only some items are picked; clicking selects all (or
 * deselects all when already fully selected).
 */
export function SelectAllControl({
  selection,
  style,
}: {
  selection: Pick<
    ChecklistSelection,
    "allSelected" | "someSelected" | "selectAll" | "deselectAll"
  >;
  style?: CSSProperties;
}) {
  const { allSelected, someSelected, selectAll, deselectAll } = selection;
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  return (
    <label
      title="Toggle all · Shift-click a row to range-select · Ctrl/Cmd-click to multi-select"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        fontSize: 11,
        color: "var(--ink-3)",
        userSelect: "none",
        ...style,
      }}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={allSelected}
        onChange={() => (allSelected ? deselectAll() : selectAll())}
        style={{ accentColor: "var(--accent)", cursor: "pointer" }}
      />
      {allSelected ? "Deselect all" : "Select all"}
    </label>
  );
}
