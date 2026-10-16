import { describe, expect, it } from "vitest";
import { normalizeFindingPath, repoName, vscodeUrl } from "../../src/shared/paths";

describe("normalizeFindingPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeFindingPath("src\\auth\\session.ts", "C:\\repo")).toBe("src/auth/session.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizeFindingPath("./src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("makes an absolute Windows path inside the repo relative (case-insensitive drive/dirs)", () => {
    expect(
      normalizeFindingPath("c:\\Users\\MichałMiszczuk\\Code\\app\\src\\a.ts", "C:\\Users\\MichałMiszczuk\\Code\\app"),
    ).toBe("src/a.ts");
  });

  it("makes an absolute POSIX path inside the repo relative", () => {
    expect(normalizeFindingPath("/home/me/app/src/a.ts", "/home/me/app/")).toBe("src/a.ts");
  });

  it("rejects an absolute path outside the repo", () => {
    expect(() => normalizeFindingPath("C:\\other\\a.ts", "C:\\repo")).toThrow(/outside repoRoot/);
  });

  it("rejects a sibling dir sharing a prefix", () => {
    expect(() => normalizeFindingPath("C:/repo-other/a.ts", "C:/repo")).toThrow(/outside repoRoot/);
  });

  it("rejects .. segments", () => {
    expect(() => normalizeFindingPath("src/../../etc/passwd", "/repo")).toThrow(/\.\./);
  });
});

describe("vscodeUrl", () => {
  it("encodes non-ASCII, spaces and # in Windows paths", () => {
    expect(vscodeUrl("C:\\Users\\MichałMiszczuk\\My Code", "src/a#b.ts", 42)).toBe(
      "vscode://file/C:/Users/Micha%C5%82Miszczuk/My%20Code/src/a%23b.ts:42",
    );
  });

  it("handles POSIX roots", () => {
    expect(vscodeUrl("/home/me/app/", "src/a.ts", 3)).toBe("vscode://file/home/me/app/src/a.ts:3");
  });
});

describe("repoName", () => {
  it("returns the last path segment", () => {
    expect(repoName("C:\\Users\\me\\Code\\review-app\\")).toBe("review-app");
    expect(repoName("/home/me/app")).toBe("app");
  });
});
