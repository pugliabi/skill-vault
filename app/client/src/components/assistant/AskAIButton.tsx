import { useQuery } from "@tanstack/react-query";
import { assistantApi } from "../../lib/assistant";
import { openAssistant, type OpenAssistantOptions } from "../../lib/assistantStore";
import { Icon } from "../ui/icons";
import { Button } from "../ui/primitives";

/**
 * The one "Ask AI" entry point used everywhere (update failures, sync
 * errors, skill panels, Notion pages). Gated on assistant availability —
 * disabled with the reason as tooltip when the claude CLI isn't usable.
 * Opens the panel with context pre-seeded; never auto-sends.
 */
export function AskAIButton({
  options,
  label = "Ask AI",
  size = "sm",
  kind = "ghost",
  onBeforeOpen,
}: {
  options: OpenAssistantOptions;
  label?: string;
  size?: "sm" | "md";
  kind?: "ghost" | "default" | "accent";
  /** e.g. close the dialog that hosts the button before the panel opens. */
  onBeforeOpen?: () => void;
}) {
  const status = useQuery({
    queryKey: ["assistant-status"],
    queryFn: () => assistantApi.status(),
    staleTime: 60_000,
  });
  const available = status.data?.available ?? false;

  return (
    <Button
      kind={kind}
      size={size}
      icon={Icon.sparkle}
      disabled={status.data !== undefined && !available}
      title={status.data && !available ? (status.data.reason ?? "Assistant unavailable") : undefined}
      onClick={() => {
        onBeforeOpen?.();
        openAssistant(options);
      }}
    >
      {label}
    </Button>
  );
}
