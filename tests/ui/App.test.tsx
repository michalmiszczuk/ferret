// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewSummary, StoreEvent } from "../../src/shared/api-types";
import type { Review } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

// Stand-ins for the network layer and the Shiki-backed code view.
const api = vi.hoisted(() => ({
  fetchReviews: vi.fn(),
  fetchReview: vi.fn(),
  patchFinding: vi.fn(),
  fetchFile: vi.fn(),
  subscribe: vi.fn(),
  fetchClaudeStatus: vi.fn(),
  fetchLatestSession: vi.fn(async () => null),
  fetchClaudeAgents: vi.fn(async () => ({ agents: [], canDeliver: true })),
  fetchWhiteboardStatus: vi.fn(async () => ({ registered: false, running: false })),
  openInWhiteboard: vi.fn(),
  deliverToAgent: vi.fn(),
  connectClaude: vi.fn(),
  fetchJobs: vi.fn(async () => []),
  cancelJob: vi.fn(),
  fetchEnv: vi.fn(async () => ({ gh: { installed: true, loggedIn: true }, claude: { installed: true }, git: { installed: true } })),
  fetchRepos: vi.fn(async () => ({ repos: [] })),
  fetchRepoInfo: vi.fn(),
  fetchPrs: vi.fn(async () => []),
  fetchCommits: vi.fn(async () => []),
  startJob: vi.fn(),
  pickFolder: vi.fn(),
  NeedsRepo: class NeedsRepo extends Error {},
}));
vi.mock("../../src/ui/api", () => api);
vi.mock("../../src/ui/components/CodeView", () => ({
  CodeView: ({ review, finding }: { review: Review; finding: { id: string; title: string } }) => (
    <div data-testid="code-view">{`${review.id}:${finding.id}:${finding.title}`}</div>
  ),
}));

import { App } from "../../src/ui/App";

const reviewA: Review = {
  id: "r_aaaaaa", createdAt: "2026-10-15T11:00:00.000Z", repoRoot: "C:/repo", summary: "A", agent: "claude",
  scope: { kind: "diff", target: "uncommitted" },
  findings: [makeFinding({ id: "f1", severity: "critical", title: "A critical" }), makeFinding({ id: "f2", severity: "low", title: "A low" })],
};
const reviewB: Review = {
  ...reviewA, id: "r_bbbbbb", createdAt: "2026-10-15T10:00:00.000Z", summary: "B",
  findings: [makeFinding({ id: "f1", severity: "low", title: "B low" }), makeFinding({ id: "f2", severity: "critical", title: "B critical" })],
};
const summary = (r: Review): ReviewSummary => ({
  id: r.id, createdAt: r.createdAt, repoName: "repo", scope: r.scope,
  counts: { critical: 1, high: 0, medium: 0, low: 1 }, pending: 0, total: 2, label: "repo · uncommitted changes",
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let emit: (e: StoreEvent) => void = () => {};

beforeEach(() => {
  history.replaceState(null, "", "/");
  api.fetchReviews.mockResolvedValue([summary(reviewA), summary(reviewB)]);
  api.fetchReview.mockImplementation(async (id: string) => (id === reviewA.id ? reviewA : reviewB));
  api.subscribe.mockImplementation((fn: (e: StoreEvent) => void) => {
    emit = fn;
    return () => {};
  });
  api.fetchClaudeStatus.mockResolvedValue({ connected: true, skillsInstalled: true, mcpRegistered: true });
});

describe("Connect Claude", () => {
  it("offers Connect Claude when not connected, and shows connected after clicking", async () => {
    api.fetchReviews.mockResolvedValue([]);
    api.fetchClaudeStatus
      .mockResolvedValueOnce({ connected: false, skillsInstalled: false, mcpRegistered: false })
      .mockResolvedValue({ connected: true, skillsInstalled: true, mcpRegistered: true });
    api.connectClaude.mockResolvedValue({ ok: true, message: "Claude connected. Start a new Claude Code session and run /ai-review." });
    render(<App />);

    const buttons = await screen.findAllByRole("button", { name: "Connect Claude" });
    expect(buttons.length).toBeGreaterThan(0); // header + getting-started step
    await userEvent.click(buttons[0]);

    expect(api.connectClaude).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Claude connected\. Start a new Claude Code session/)).toBeTruthy(); // toast
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Connect Claude" })).toBeNull());
    expect(screen.getByText("✓ Claude connected")).toBeTruthy();
  });

  it("shows the failure message when connecting fails", async () => {
    api.fetchReviews.mockResolvedValue([]);
    api.fetchClaudeStatus.mockResolvedValue({ connected: false, skillsInstalled: false, mcpRegistered: false });
    api.connectClaude.mockResolvedValue({ ok: false, message: "Could not register the MCP server automatically." });
    render(<App />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Connect Claude" }))[0]);
    expect(await screen.findByText(/Could not register the MCP server/)).toBeTruthy();
  });

  it("hides the button when the server has no Claude integration (status unavailable)", async () => {
    api.fetchClaudeStatus.mockRejectedValue(new Error("404"));
    render(<App />);
    await screen.findByTestId("code-view");
    expect(screen.queryByRole("button", { name: "Connect Claude" })).toBeNull();
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App with no reviews", () => {
  it("keeps the findings panel layout instead of a blank page", async () => {
    api.fetchReviews.mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText("No findings yet.")).toBeTruthy();
    expect(screen.getByText("Findings")).toBeTruthy();
    expect(screen.getByText(/No reviews yet/)).toBeTruthy();
  });
});

describe("App review switching", () => {
  it("selects the top finding of the newly selected review, not the old review's id", async () => {
    render(<App />);
    expect((await screen.findByTestId("code-view")).textContent).toBe("r_aaaaaa:f1:A critical");

    await userEvent.selectOptions(screen.getByLabelText("Switch review"), reviewB.id);

    await vi.waitFor(() => expect(screen.getByTestId("code-view").textContent).toContain("r_bbbbbb"));
    expect(screen.getByTestId("code-view").textContent).toBe("r_bbbbbb:f2:B critical");
  });

  it("ignores a late live-update fetch for a review the user already left", async () => {
    render(<App />);
    await screen.findByTestId("code-view");

    const lateA = deferred<Review>();
    api.fetchReview.mockImplementationOnce(() => lateA.promise); // the SSE refetch of A hangs
    act(() => emit({ type: "review-updated", reviewId: reviewA.id }));

    await userEvent.selectOptions(screen.getByLabelText("Switch review"), reviewB.id);
    await vi.waitFor(() => expect(screen.getByTestId("code-view").textContent).toContain("r_bbbbbb"));

    await act(async () => lateA.resolve(reviewA));
    expect(screen.getByTestId("code-view").textContent).toContain("r_bbbbbb");
  });
});
