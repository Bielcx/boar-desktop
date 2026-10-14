import { describe, it, expect } from "vitest";
import { registerResetHook, RESET_ORDER, runReset, runResetHooks, type ResetSteps } from "./resetOrder";

function recorder(failAt?: keyof ResetSteps) {
  const calls: string[] = [];
  const steps = Object.fromEntries(
    RESET_ORDER.map((name) => [
      name,
      async () => {
        calls.push(name);
        if (name === failAt) throw new Error(`${name} failed`);
      },
    ])
  ) as unknown as ResetSteps;
  return { calls, steps };
}

describe("Erase everything order (Prism RS-1)", () => {
  it("stops downloads and releases models, forgets stores and wipes the database before deleting any file", async () => {
    const { calls, steps } = recorder();
    await runReset(steps);
    expect(calls).toEqual(["cancelDownloads", "unloadEngines", "forgetStores", "wipeDatabase", "deleteFiles", "clearSettings"]);
  });

  it("deletes nothing when a step before it fails", async () => {
    for (const failAt of ["unloadEngines", "forgetStores", "wipeDatabase"] as const) {
      const { calls, steps } = recorder(failAt);
      await expect(runReset(steps)).rejects.toThrow(`${failAt} failed`);
      expect(calls).not.toContain("deleteFiles");
      expect(calls.at(-1)).toBe(failAt);
    }
  });

  it("runs each step after the previous one finished, not in parallel", async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    };
    await runReset({
      cancelDownloads: slow("cancel", 5),
      unloadEngines: slow("unload", 1),
      forgetStores: slow("forget", 5),
      wipeDatabase: slow("wipe", 1),
      deleteFiles: slow("delete", 1),
      clearSettings: slow("settings", 1),
    });
    expect(log.indexOf("forget:end")).toBeLessThan(log.indexOf("wipe:start"));
    expect(log.indexOf("wipe:end")).toBeLessThan(log.indexOf("delete:start"));
  });
});

describe("reset hooks", () => {
  it("runs the hooks of one phase only, and a name registered again replaces the old hook", async () => {
    const ran: string[] = [];
    registerResetHook("forget", "places", async () => void ran.push("places-old"));
    registerResetHook("forget", "places", async () => void ran.push("places"));
    registerResetHook("forget", "packs", async () => void ran.push("packs"));
    registerResetHook("wipe", "knowledge-base", async () => void ran.push("wipe"));
    await runResetHooks("forget");
    expect(ran.sort()).toEqual(["packs", "places"]);
    await runResetHooks("wipe");
    expect(ran).toContain("wipe");
  });
});

describe("required reset hooks", () => {
  it("fails, instead of skipping, when a required hook isn't registered", async () => {
    await expect(runResetHooks("wipe", ["no-such-store"])).rejects.toThrow(/no hook for: no-such-store/);
  });
});

