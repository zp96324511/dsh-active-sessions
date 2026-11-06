// Dev-only probe: boots the DSH profile-resolution interception inside this
// worker, then imports the plugin exactly the way the host does, so bare
// imports of platform packages either resolve or fail here instead of at the
// next host restart.
const target = process.env.PROBE_TARGET

const report = { target, steps: [] }

try {
  await import(
    'file:///C:/Users/win10/AppData/Local/Author%20Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js'
  )
  report.steps.push('bootstrap loaded')
} catch (error) {
  report.steps.push(`bootstrap failed: ${error?.message ?? error}`)
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}

for (const name of ['zod', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-typert-protocol']) {
  try {
    const url = await import.meta.resolve(name)
    report.steps.push(`resolve ${name} -> ${url}`)
  } catch (error) {
    report.steps.push(`resolve ${name} FAILED: ${error?.code ?? ''} ${error?.message ?? error}\n${(error?.stack ?? '').split('\n').slice(1, 5).join('\n')}`)
  }
}

try {
  const mod = await import(target)
  report.steps.push(`plugin loaded: ${Object.keys(mod).join(',')}`)
} catch (error) {
  report.steps.push(`plugin load FAILED: ${error?.code ?? ''} ${error?.message ?? error}`)
}

console.log(JSON.stringify(report, null, 2))
