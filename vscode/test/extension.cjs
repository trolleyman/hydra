const assert = require('node:assert/strict')
const vscode = require('vscode')

async function run() {
  const extension = vscode.extensions.getExtension('trolleyman.hydra')
  assert.ok(extension, 'Hydra extension is installed in the Extension Development Host')
  await extension.activate()

  const commands = await vscode.commands.getCommands(true)
  for (const command of ['hydra.newChat', 'hydra.showHistory', 'hydra.showProfiles', 'hydra.cycleProfile', 'hydra.moveToSecondarySidebar']) {
    assert.ok(commands.includes(command), `${command} is registered`)
  }

  const manifest = extension.packageJSON
  const defaults = manifest.contributes.configuration.properties['hydra.profiles'].default
  assert.equal(defaults.plan.name, 'Plan')
  assert.equal(defaults.plan.tools.core.edit, 'deny')
  assert.equal(defaults.edit.name, 'Edit')
  assert.equal(defaults.edit.tools.core.edit, 'allow')
  assert.equal(manifest.contributes.configuration.properties['hydra.defaultProfile'].default, 'edit')

  await vscode.commands.executeCommand('hydra.showProfiles')
}

module.exports = { run }
