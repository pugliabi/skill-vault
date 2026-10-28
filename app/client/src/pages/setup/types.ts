import type { SetupDraft, SetupStep } from "../../lib/setup";

/** What every step component gets from the guide's shell (SetupGuide.tsx). */
export interface StepProps {
  draft: SetupDraft;
  /** Save `patch` into the draft and go to `to`. */
  commit: (patch: Partial<SetupDraft>, to: SetupStep) => Promise<void>;
  /** Go to another step without changing anything else. */
  goTo: (to: SetupStep) => void;
  /** The Windows folder dialog can be used (Browse buttons). */
  folderDialog: boolean;
  /** The assistant API key, kept in page memory only (never in the draft). */
  apiKey: string;
  setApiKey: (key: string) => void;
  /** Called after a successful Finish. */
  onFinished: () => void;
}
