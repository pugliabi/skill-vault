import { useRef, useState } from "react";

interface TagChipsProps {
  tags: string[];
  allTags?: string[];
  editable?: boolean;
  onAdd?: (tag: string) => void;
  onRemove?: (tag: string) => void;
}

const TAG_HUES = [30, 60, 120, 180, 210, 270, 310, 350];

function tagColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const hue = TAG_HUES[Math.abs(hash) % TAG_HUES.length];
  return `oklch(0.75 0.1 ${hue})`;
}

function tagBg(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const hue = TAG_HUES[Math.abs(hash) % TAG_HUES.length];
  return `oklch(0.75 0.1 ${hue} / 0.12)`;
}

export function TagChips({ tags, allTags, editable, onAdd, onRemove }: TagChipsProps) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions =
    adding && input.trim()
      ? (allTags ?? []).filter(
          (t) =>
            t.toLowerCase().includes(input.trim().toLowerCase()) &&
            !tags.includes(t),
        )
      : [];

  const commit = (val: string) => {
    const trimmed = val.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      onAdd?.(trimmed);
    }
    setInput("");
    setAdding(false);
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {tags.map((tag) => (
        <span
          key={tag}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            padding: "2px 7px",
            borderRadius: 3,
            color: tagColor(tag),
            background: tagBg(tag),
            border: `0.5px solid ${tagColor(tag)}`,
            lineHeight: 1.4,
          }}
        >
          {tag}
          {editable && onRemove && (
            <button
              onClick={() => onRemove(tag)}
              style={{
                border: 0,
                background: "transparent",
                color: tagColor(tag),
                cursor: "pointer",
                padding: 0,
                fontSize: 11,
                lineHeight: 1,
                marginLeft: 1,
                opacity: 0.7,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.7"; }}
            >
              ×
            </button>
          )}
        </span>
      ))}

      {editable && onAdd && !adding && (
        <button
          onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          style={{
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            padding: "2px 6px",
            borderRadius: 3,
            color: "var(--ink-3)",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            cursor: "pointer",
            lineHeight: 1.4,
          }}
        >
          +
        </button>
      )}

      {editable && adding && (
        <div style={{ position: "relative" }}>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(input); }
              else if (e.key === "Escape") { setAdding(false); setInput(""); }
            }}
            onBlur={() => { setTimeout(() => { setAdding(false); setInput(""); }, 150); }}
            placeholder="tag…"
            style={{
              width: 80,
              height: 20,
              fontSize: 10.5,
              fontFamily: "var(--mono)",
              padding: "0 5px",
              border: "0.5px solid var(--border-2)",
              borderRadius: 3,
              background: "var(--surface)",
              color: "var(--ink)",
              outline: 0,
            }}
          />
          {suggestions.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 2,
                background: "var(--bg)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 4,
                boxShadow: "0 4px 12px oklch(0.2 0.01 60 / 0.15)",
                zIndex: 60,
                minWidth: 100,
                maxHeight: 120,
                overflowY: "auto",
                padding: 2,
              }}
            >
              {suggestions.slice(0, 8).map((s) => (
                <button
                  key={s}
                  onMouseDown={(e) => { e.preventDefault(); commit(s); }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 6px",
                    border: 0,
                    background: "transparent",
                    fontSize: 10.5,
                    fontFamily: "var(--mono)",
                    color: tagColor(s),
                    cursor: "pointer",
                    borderRadius: 3,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
