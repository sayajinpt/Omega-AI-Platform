const fs = require('fs')
const path = require('path')

/** @param {string} officeRoot */
function standaloneAppDir(officeRoot) {
  const flat = path.join(officeRoot, '.next', 'standalone')
  const nested = path.join(flat, 'apps', 'desktop', 'claw3d-office')
  if (fs.existsSync(path.join(nested, 'server.js'))) return nested
  return flat
}

module.exports = { standaloneAppDir }
