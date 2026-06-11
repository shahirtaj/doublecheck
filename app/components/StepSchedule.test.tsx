// @vitest-environment jsdom
import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSchedule, type ScheduleSuccess } from "@/lib/algorithm";
import { initialState, type State } from "./state";
import { StepSchedule } from "./StepSchedule";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedSchedule(): ScheduleSuccess {
  const result = buildSchedule({
    teamCount: 8,
    weekCount: 13,
    random: mulberry32(0xd0b1e),
  });
  if (!result.ok) throw new Error("test setup: schedule generation failed");
  return result;
}

// Minimal stateful stand-in for page.tsx: useState owns State, patch is a
// merging setState, the generation seq ref is a plain object, and the
// onGenerate stub mimics handleGenerate's supersession side effects (bump
// the seq, reset share state) without generating a new schedule.
function renderStepSchedule(seed: Partial<State>) {
  const generateSeqRef = { current: 0 } as MutableRefObject<number>;
  const saveToStorage = vi.fn();
  let current: State = { ...initialState, ...seed };
  let patchRef: (p: Partial<State>) => void = () => {};

  function Harness() {
    const [state, setState] = useState<State>(current);
    const patch = useCallback(
      (p: Partial<State>) => setState((prev) => ({ ...prev, ...p })),
      [],
    );
    current = state;
    patchRef = patch;
    return (
      <StepSchedule
        state={state}
        patch={patch}
        saveToStorage={saveToStorage}
        scheduleYear={2026}
        onGenerate={() => {
          generateSeqRef.current++;
          patch({
            saved: false,
            shareStatus: "idle",
            shareUrl: "",
            shareError: "",
            shareCopied: false,
          });
        }}
        generateSeqRef={generateSeqRef}
      />
    );
  }

  render(<Harness />);
  return {
    getState: () => current,
    patch: (p: Partial<State>) => patchRef(p),
    generateSeqRef,
    saveToStorage,
  };
}

function scheduleSeed(): Partial<State> {
  return {
    schedule: generatedSchedule(),
    selectedFormat: { teamCount: 8, weekCount: 13 },
    teams: Array.from({ length: 8 }, (_, i) => `Team ${i + 1}`),
    userIds: Array.from({ length: 8 }, () => null),
    step: "schedule",
    furthestStep: "schedule",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// Vitest runs without globals, so testing-library can't auto-register its
// cleanup - do it explicitly alongside the fetch unstub.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Save & Share supersession", () => {
  it("lands the share link when nothing supersedes the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ url: "/s/abc12345" })),
    );
    const h = renderStepSchedule(scheduleSeed());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save & Share" }));

    await waitFor(() => expect(h.getState().shareStatus).toBe("ready"));
    expect(h.getState().shareUrl).toContain("/s/abc12345");
    expect(h.getState().saved).toBe(true);
  });

  it("discards a share response that lands after a regenerate", async () => {
    // Regenerate while the POST is in flight resets share state for a new
    // schedule; the old schedule's response must not patch a link (or an
    // error) over it.
    let resolveFetch!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );
    const h = renderStepSchedule(scheduleSeed());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save & Share" }));
    expect(h.getState().shareStatus).toBe("loading");

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    resolveFetch(jsonResponse({ url: "/s/old12345" }));
    // Let the handler's post-await code run to completion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(h.getState().shareStatus).toBe("idle");
    expect(h.getState().shareUrl).toBe("");
  });

  it("discards a share failure that lands after a regenerate", async () => {
    let rejectFetch!: (e: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
      ),
    );
    const h = renderStepSchedule(scheduleSeed());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Save & Share" }));
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    rejectFetch(new Error("network down"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(h.getState().shareStatus).toBe("idle");
    expect(h.getState().shareError).toBe("");
  });
});
