import { execFile } from "node:child_process";

/** Opens a URL with the OS handler (vscode://, https://). Used when no Electron shell is available. */
export function openWithOs(url: string): Promise<void> {
  // rundll32 avoids cmd.exe parsing, which would split vscode://…?a=1&b=2 at the "&".
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args as string[], (err) => (err ? reject(err) : resolve()));
  });
}
