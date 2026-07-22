/**
 * Devices service — snapshot read/write/compare for multi-machine vault sync.
 *
 * Snapshots live at <vault>/snapshots/<machine_id>.json and capture the
 * vault's skill state at a point in time so other machines can sync from it.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readManifest } from "./vault.ts";
import { hashSkillFolder } from "./skillHash.ts";

export interface DeviceSnapshot {
  machine_id: string;
  timestamp: string;
  skill_count: number;
  skills: Record<string, {
    stage: "staging" | "production";
    targets: string[];
    hash: string;
    modified_at: string;
  }>;
}

export interface DeviceInfo {
  machine_id: string;
  skill_count: number;
  timestamp: string;
  is_current: boolean;
}

export interface SyncComparison {
  skill: string;
  local_stage: string | null;
  remote_stage: string | null;
  local_hash: string | null;
  remote_hash: string | null;
  status: "same" | "local_only" | "remote_only" | "diverged";
}

export function snapshotsDir(vaultPath: string): string {
  return path.join(vaultPath, "snapshots");
}

export function loadSnapshot(vaultPath: string, deviceName: string): DeviceSnapshot {
  const file = path.join(snapshotsDir(vaultPath), `${deviceName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No snapshot found for device: ${deviceName}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as DeviceSnapshot;
}

function currentMachineId(): string {
  return os.hostname().toUpperCase();
}

export function listDevices(vaultPath: string): DeviceInfo[] {
  const dir = snapshotsDir(vaultPath);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const current = currentMachineId();
  const devices: DeviceInfo[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const snap = JSON.parse(raw) as DeviceSnapshot;
      devices.push({
        machine_id: snap.machine_id,
        skill_count: snap.skill_count,
        timestamp: snap.timestamp,
        is_current: snap.machine_id === current,
      });
    } catch {
      // skip corrupt snapshot files
    }
  }

  // Current device first, then alphabetical
  devices.sort((a, b) => {
    if (a.is_current && !b.is_current) return -1;
    if (!a.is_current && b.is_current) return 1;
    return a.machine_id.localeCompare(b.machine_id);
  });

  return devices;
}

export function saveSnapshot(vaultPath: string): DeviceSnapshot {
  const dir = snapshotsDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = readManifest(vaultPath);
  const machineId = currentMachineId();
  const skillsDirPath = path.join(vaultPath, "skills");
  const stagingDir = path.join(vaultPath, "staging");

  const skills: DeviceSnapshot["skills"] = {};

  for (const [name, entry] of Object.entries(manifest.skills)) {
    const stage = entry.stage || "production";
    const base = stage === "staging" ? stagingDir : skillsDirPath;
    const skillDir = path.join(base, name);
    let hash = "";
    let modified_at = new Date().toISOString();

    if (fs.existsSync(skillDir)) {
      hash = hashSkillFolder(skillDir) ?? "";
      try {
        const stat = fs.statSync(skillDir);
        modified_at = stat.mtime.toISOString();
      } catch { /* use default */ }
    }

    skills[name] = {
      stage: stage as "staging" | "production",
      targets: entry.targets || [],
      hash,
      modified_at,
    };
  }

  const snapshot: DeviceSnapshot = {
    machine_id: machineId,
    timestamp: new Date().toISOString(),
    skill_count: Object.keys(skills).length,
    skills,
  };

  const file = path.join(dir, `${machineId}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  return snapshot;
}

export function compareDevice(
  vaultPath: string,
  deviceName: string,
): SyncComparison[] {
  const dir = snapshotsDir(vaultPath);
  const file = path.join(dir, `${deviceName}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`No snapshot found for device: ${deviceName}`);
  }

  const raw = fs.readFileSync(file, "utf-8");
  const remote = JSON.parse(raw) as DeviceSnapshot;
  const manifest = readManifest(vaultPath);

  const allSkills = new Set([
    ...Object.keys(manifest.skills),
    ...Object.keys(remote.skills),
  ]);

  const results: SyncComparison[] = [];
  for (const skill of allSkills) {
    const local = manifest.skills[skill];
    const remoteSkill = remote.skills[skill];

    if (local && !remoteSkill) {
      results.push({
        skill,
        local_stage: local.stage || "production",
        remote_stage: null,
        local_hash: null,
        remote_hash: null,
        status: "local_only",
      });
    } else if (!local && remoteSkill) {
      results.push({
        skill,
        local_stage: null,
        remote_stage: remoteSkill.stage,
        local_hash: null,
        remote_hash: remoteSkill.hash,
        status: "remote_only",
      });
    } else if (local && remoteSkill) {
      const localStage = local.stage || "production";
      const same = localStage === remoteSkill.stage;
      results.push({
        skill,
        local_stage: localStage,
        remote_stage: remoteSkill.stage,
        local_hash: null,
        remote_hash: remoteSkill.hash,
        status: same ? "same" : "diverged",
      });
    }
  }

  // Sort: diverged/remote_only first (actionable), then same, then local_only
  const order = { diverged: 0, remote_only: 1, local_only: 2, same: 3 };
  results.sort((a, b) => order[a.status] - order[b.status]);

  return results;
}

export function getCurrentMachineId(): string {
  return currentMachineId();
}
