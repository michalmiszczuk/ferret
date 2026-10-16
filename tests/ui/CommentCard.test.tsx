// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentCard } from "../../src/ui/components/CommentCard";
import type { Finding } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

afterEach(cleanup);

function setup(f: Partial<Finding> = {}, anchor: "exact" | "moved" | "lost" | "missing" = "exact") {
  const onUpdate = vi.fn();
  const finding = makeFinding({
    severity: "critical", category: "security", title: "Token never expires",
    body: "Sessions are **never** checked.", suggestion: "Check `expiresAt`.", snippet: "return s.user", ...f,
  });
  render(<CommentCard finding={finding} anchor={anchor} onUpdate={onUpdate} />);
  return onUpdate;
}

describe("CommentCard", () => {
  it("shows severity, category, title, markdown body and suggestion", () => {
    setup();
    expect(screen.getByText(/CRITICAL/)).toBeTruthy();
    expect(screen.getByText(/security/)).toBeTruthy();
    expect(screen.getByText("Token never expires")).toBeTruthy();
    expect(screen.getByText("never").tagName).toBe("STRONG");
    expect(screen.getByText("expiresAt").tagName).toBe("CODE");
  });

  it("Fix toggles fix_requested on and off", async () => {
    const onUpdate = setup();
    await userEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ status: "fix_requested" });
    cleanup();

    const onUpdate2 = setup({ status: "fix_requested" });
    await userEvent.click(screen.getByRole("button", { name: /Fix requested/ }));
    expect(onUpdate2).toHaveBeenLastCalledWith({ status: "open" });
  });

  it("Dismiss sets dismissed", async () => {
    const onUpdate = setup();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onUpdate).toHaveBeenCalledWith({ status: "dismissed" });
  });

  it("changing severity sends the new severity and shows Claude's original", async () => {
    const onUpdate = setup();
    await userEvent.selectOptions(screen.getByLabelText(/Severity/), "low");
    expect(onUpdate).toHaveBeenCalledWith({ severity: "low" });
    cleanup();
    setup({ severity: "low", originalSeverity: "critical" });
    expect(screen.getByText(/Claude said Critical/)).toBeTruthy();
  });

  it("saves the note on blur only when it changed", async () => {
    const onUpdate = setup();
    const note = screen.getByLabelText("Note to Claude");
    await userEvent.click(note);
    await userEvent.tab();
    expect(onUpdate).not.toHaveBeenCalled();
    await userEvent.type(note, "keep API");
    await userEvent.tab();
    expect(onUpdate).toHaveBeenCalledWith({ myNote: "keep API" });
  });

  it("while fixing: no Fix/Dismiss, offers Reset to open", async () => {
    const onUpdate = setup({ status: "fixing" });
    expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset to open" }));
    expect(onUpdate).toHaveBeenCalledWith({ status: "open" });
  });

  it("shows Claude's resolution", () => {
    setup({ status: "fixed", resolution: "Added expiry check" });
    expect(screen.getByText("Added expiry check")).toBeTruthy();
  });

  it("warns and shows the original snippet when the anchor is lost or the file is missing", () => {
    setup({}, "lost");
    expect(screen.getByText(/code changed since review/)).toBeTruthy();
    expect(screen.getByText("return s.user")).toBeTruthy();
    cleanup();
    setup({}, "missing");
    expect(screen.getByText(/file no longer exists/)).toBeTruthy();
  });
});
