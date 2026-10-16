// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingsList } from "../../src/ui/components/FindingsList";
import type { Filters } from "../../src/shared/findings";
import { SEVERITIES } from "../../src/shared/schema";
import { makeFinding } from "../helpers";

afterEach(cleanup);

const all: Filters = { severities: [...SEVERITIES], status: "all" };
const findings = [
  makeFinding({ id: "low", severity: "low", title: "Rename var", file: "a.ts", lineStart: 3 }),
  makeFinding({ id: "crit", severity: "critical", title: "SQL injection", file: "db.ts", lineStart: 88 }),
  makeFinding({ id: "fixed", severity: "high", title: "Already fixed", status: "fixed" }),
  makeFinding({ id: "dis", severity: "medium", title: "Not relevant", status: "dismissed" }),
];

function setup(over: Partial<Parameters<typeof FindingsList>[0]> = {}) {
  const props = {
    findings, filters: all, onFiltersChange: vi.fn(), selectedId: null, onSelect: vi.fn(),
    doneOpen: false, onToggleDone: vi.fn(), ...over,
  };
  render(<FindingsList {...props} />);
  return props;
}

describe("FindingsList", () => {
  it("shows active findings critical first, with file:line", () => {
    setup();
    const rows = screen.getAllByTestId("finding-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("SQL injection"),
      expect.stringContaining("Rename var"),
    ]);
    expect(rows[0].textContent).toContain("db.ts:88");
  });

  it("calls onSelect with the finding id", async () => {
    const p = setup();
    await userEvent.click(screen.getByText("SQL injection"));
    expect(p.onSelect).toHaveBeenCalledWith("crit");
  });

  it("marks the selected row", () => {
    setup({ selectedId: "low" });
    const row = screen.getByText("Rename var").closest("button")!;
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("collapses the done group and toggles it", async () => {
    const p = setup();
    expect(screen.queryByText("Already fixed")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Done \(2\)/ }));
    expect(p.onToggleDone).toHaveBeenCalled();
  });

  it("shows done findings when the group is open", () => {
    setup({ doneOpen: true });
    expect(screen.getByText("Already fixed")).toBeTruthy();
    expect(screen.getByText("Not relevant")).toBeTruthy();
  });

  it("toggling a severity chip removes it from the filter", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: /Low/ }));
    expect(p.onFiltersChange).toHaveBeenCalledWith({ ...all, severities: ["critical", "high", "medium"] });
  });

  it("shows an empty message when nothing matches", () => {
    setup({ filters: { severities: [], status: "all" } });
    expect(screen.getByText(/No findings match/)).toBeTruthy();
  });
});
