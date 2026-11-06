// Dev-only probe driver: feeds the profile-resolution bootstrap the same
// shape the launcher builds, then loads the installed plugin in a worker.
import { Worker, setEnvironmentData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const INSTALL =
  'C:/Users/win10/AppData/Local/Author Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/node_modules'
const PROFILE = 'C:/Users/win10/.dsh/profiles/web'
const PLUGIN_DIR = process.argv[2] ?? `${PROFILE}/node_modules/dsh-active-sessions`

const platformPackages = [
  'zod',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/cordis',
]

const resolution = {
  entries: platformPackages.map((name) => ({
    name,
    packageDir: `${INSTALL}/${name}`,
    scope: 'installation',
    declarer: 'C:/Users/win10/AppData/Local/Author Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/package.json',
  })),
  profilesDir: 'C:/Users/win10/.dsh/profiles',
  profileDir: PROFILE,
  linkedRoots: [{ name: 'dsh-active-sessions', realPath: 'C:/data/projects/dsh-active-sessions' }],
  localPackageNames: ['dsh-active-sessions'],
}

setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', { resolution })

const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
  env: { ...process.env, PROBE_TARGET: pathToFileURL(`${PLUGIN_DIR}/index.js`).href },
})

let out = ''
worker.stdout.on('data', (chunk) => {
  out += chunk
})
worker.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
})
await new Promise((resolve) => worker.on('exit', resolve))
process.stdout.write(out)
