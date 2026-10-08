import { useState } from "react";
import type { ToolBlock } from "../../lib/assistantStore";
import { Icon } from "../ui/icons";

/**
 * One compact, scannable line per tool call: status glyph + tool icon +
 * human label + duration; click to expand input/output previews. Raw JSON
 * never renders inline — that's what the expand is for.
 */

function toolIcon(name: string) {
  if (name.startsWith("mcp__vault__")) return Icon.wrench;
  switch (name) {
    case "Bash":
      return Icon.terminal;
    case "WebSearch":
    case "WebFetch":
      return Icon.globe;
    case "Edit":
    case "Write":
      return Icon.edit;
    case "Read":
    case "Glob":
    case "Grep":
      return Icon.search;
    case "Task":
    case "Agent":
    case "Skill":
      return Icon.sparkle;
    default:
      return Icon.chevron;
  }
}

function Spinner() {
  return (
    <svg className="sv-spin" width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ display: "block" }}>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <path d="M6 1.5a4.5 4.5 0 014.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ToolActivityLine({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(block.inputPreview || block.outputPreview);

  const glyph =
    block.state === "running" ? (
      <span style={{ color: "var(--accent)" }}>
        <Spinner />
      </span>
    ) : block.state === "ok" ? (
      <span style={{ color: "var(--ok)", display: "inline-flex" }}>{Icon.check}</span>
    ) : (
      <span style={{ color: "var(--bad)", display: "inline-flex" }}>{Icon.x}</span>
    );

  return (
    <div>
      <div
        onClick={() => hasDetail && setExpanded((v) => !v)}
        title={hasDetail ? (expanded ? "Hide detail" : "Show input/output") : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "3px 0",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--ink-2)",
          cursor: hasDetail ? "pointer" : "default",
          minWidth: 0,
        }}
      >
        <span style={{ flexShrink: 0, width: 12, display: "inline-flex", justifyContent: "center" }}>{glyph}</span>
        <span style={{ flexShrink: 0, display: "inline-flex", color: "var(--ink-3)" }}>{toolIcon(block.name)}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{block.label}</span>
        {typeof block.durationMs === "number" && block.durationMs > 900 && (
          <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--ink-4)" }}>
            {(block.durationMs / 1000).toFixed(block.durationMs > 9_500 ? 0 : 1)}s
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <pre
          className="sv-scroll"
          style={{
            margin: "2px 0 6px 19px",
            padding: "7px 9px",
            background: "var(--surface)",
            border: "0.5px solid var(--border-2)",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--ink-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {block.inputPreview ? `» ${block.inputPreview}` : null}
          {block.inputPreview && block.outputPreview ? "\n" : null}
          {block.outputPreview ? `« ${block.outputPreview}` : null}
        </pre>
      )}
    </div>
  );
}
