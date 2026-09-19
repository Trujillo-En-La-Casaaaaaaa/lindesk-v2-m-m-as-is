import { describe, expect, it } from "vitest";
import { OutboxRelay } from "../../../src/adapters/outbound/outbox/outbox.relay.js";
import type { DeliverPendingNotificationsUseCase } from "../../../src/application/ports/in/deliver-pending-notifications.js";

interface LogLine {
  level: "info" | "error";
  message: string;
}

function recordingLogger(lines: LogLine[]) {
  return {
    info: (message: string) => lines.push({ level: "info", message }),
    error: (message: string) => lines.push({ level: "error", message }),
  };
}

describe("OutboxRelay", () => {
  it("runs once on start and then on every interval, stopping on request", async () => {
    const runs: number[] = [];
    const useCase: DeliverPendingNotificationsUseCase = {
      execute: async () => {
        runs.push(runs.length + 1);
        return { delivered: [], failed: [] };
      },
    };
    const relay = new OutboxRelay(useCase, 20, recordingLogger([]));

    relay.start();
    expect(relay.isRunning).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await relay.stop();

    expect(relay.isRunning).toBe(false);
    expect(runs.length).toBeGreaterThanOrEqual(2);

    const afterStop = runs.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs.length).toBe(afterStop);
  });

  it("logs deliveries and failures without throwing", async () => {
    const lines: LogLine[] = [];
    const relay = new OutboxRelay(
      {
        execute: async () => ({ delivered: ["intent-1"], failed: ["intent-2"] }),
      },
      60_000,
      recordingLogger(lines),
    );

    const outcome = await relay.runOnce();

    expect(outcome).toEqual({ delivered: ["intent-1"], failed: ["intent-2"] });
    expect(lines).toEqual([
      { level: "info", message: "outbox relay: delivered 1 notification(s)" },
      {
        level: "error",
        message: "outbox relay: delivery failed for 1 intent(s), still PENDING: intent-2",
      },
    ]);
  });

  it("survives a failed pass and keeps the process healthy", async () => {
    const lines: LogLine[] = [];
    const relay = new OutboxRelay(
      {
        execute: async () => {
          throw new Error("database unavailable");
        },
      },
      60_000,
      recordingLogger(lines),
    );

    await expect(relay.runOnce()).resolves.toBeNull();
    expect(lines).toEqual([
      { level: "error", message: "outbox relay: run failed: database unavailable" },
    ]);
  });

  it("never runs two passes concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const relay = new OutboxRelay(
      {
        execute: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { delivered: [], failed: [] };
        },
      },
      60_000,
      recordingLogger([]),
    );

    const [first, second] = await Promise.all([relay.runOnce(), relay.runOnce()]);

    expect(maxActive).toBe(1);
    expect([first, second].filter((outcome) => outcome !== null)).toHaveLength(1);
  });
});
