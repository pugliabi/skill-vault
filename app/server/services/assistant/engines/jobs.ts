/** The long-running engine jobs the app must know about: busy (no idle stop, no update) and shutdown. */
import { createInstaller, type Installer } from "./install.ts";
import { createSignInManager, type SignInManager } from "./signIn.ts";

export interface EngineJobs {
  installer: Installer;
  signIn: SignInManager;
  busy(): boolean;
  stopAll(): void;
}

export function createEngineJobs(parts: { installer?: Installer; signIn?: SignInManager } = {}): EngineJobs {
  const installer = parts.installer ?? createInstaller();
  const signIn = parts.signIn ?? createSignInManager();
  return {
    installer,
    signIn,
    busy: () => installer.isRunning() || signIn.pending(),
    stopAll: () => {
      installer.stop();
      signIn.cancel();
    },
  };
}
