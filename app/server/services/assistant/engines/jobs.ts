/** The long-running engine jobs the app must know about: busy (no idle stop, no update) and shutdown. */
import { createInstaller, type Installer } from "./install.ts";

export interface EngineJobs {
  installer: Installer;
  busy(): boolean;
  stopAll(): void;
}

export function createEngineJobs(parts: { installer?: Installer } = {}): EngineJobs {
  const installer = parts.installer ?? createInstaller();
  return {
    installer,
    busy: () => installer.isRunning(),
    stopAll: () => installer.stop(),
  };
}
