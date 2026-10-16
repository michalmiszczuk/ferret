import { describe, expect, it } from "vitest";
import { claudeOpenUrl } from "../../src/shared/claude-link";

describe("claudeOpenUrl", () => {
  it("opens a new Claude tab in VS Code with the prompt pre-filled (URL-encoded)", () => {
    expect(claudeOpenUrl("/apply-review r_84ea2a")).toBe(
      "vscode://anthropic.claude-code/open?prompt=%2Fapply-review%20r_84ea2a",
    );
  });

  it("targets the conversation that made the review when its session id is known", () => {
    expect(claudeOpenUrl("/apply-review r_84ea2a", "6f1c2d3e-aaaa-bbbb-cccc-0123456789ab")).toBe(
      "vscode://anthropic.claude-code/open?prompt=%2Fapply-review%20r_84ea2a&session=6f1c2d3e-aaaa-bbbb-cccc-0123456789ab",
    );
  });

  it("ignores blank or unsubstituted session placeholders", () => {
    expect(claudeOpenUrl("/apply-review r_1", "")).not.toContain("session=");
    expect(claudeOpenUrl("/apply-review r_1", "${CLAUDE_SESSION_ID}")).not.toContain("session=");
  });
});
