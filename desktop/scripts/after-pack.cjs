// electron-builder afterPack (runs before signing): drop Electron's sample app, which the unpacked
// distribution in node_modules/electron/dist still carries. Atelier only ever loads app.asar.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
};
