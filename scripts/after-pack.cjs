// electron-builder afterPack hook: turn off the RunAsNode fuse in the packaged app.
// VS Code / Claude Code terminals export ELECTRON_RUN_AS_NODE=1, and a review-app:// launch from there
// inherits it; with the fuse off the packaged app ignores it and always starts as a real app.
const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const app =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${name}.app`)
      : path.join(context.appOutDir, `${name}.exe`);
  await flipFuses(app, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false });
};
