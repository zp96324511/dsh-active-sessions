// Dev-only: extract `createAnchorKeeper` from client.js verbatim and wrap it in
// a browser probe, so the anchor logic can be exercised against the live
// sidebar without rebuilding the client bundle or restarting the host.
//
//   node test/browser-probe/make-probe.mjs   -> writes %TEMP%/dsh-anchor-probe.js
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const start = source.indexOf('function createAnchorKeeper(options) {')
if (start < 0) throw new Error('createAnchorKeeper not found in client.js')

let depth = 0
let index = source.indexOf('{', start)
let end = -1
for (; index < source.length; index += 1) {
  const character = source[index]
  if (character === '{') depth += 1
  else if (character === '}') {
    depth -= 1
    if (depth === 0) {
      end = index + 1
      break
    }
  }
}
if (end < 0) throw new Error('unbalanced braces around createAnchorKeeper')

const keeper = source.slice(start, end)

const probe = `async () => {
  const log = () => {}
  const HOST_ATTRIBUTE = 'data-probe-anchor'
${keeper.replace(/^/gm, '  ')}

  const report = { steps: [] }
  const realQuery = Document.prototype.querySelector
  const realStyle = window.getComputedStyle
  const hits = { rows: 0, trees: 0, styles: 0, other: 0 }
  window.getComputedStyle = function (element, pseudo) {
    hits.styles += 1
    return realStyle.call(window, element, pseudo)
  }
  Document.prototype.querySelector = function (selector) {
    if (selector === '[data-row-key]') hits.rows += 1
    else if (selector === '[role="tree"]') hits.trees += 1
    else hits.other += 1
    return realQuery.call(this, selector)
  }
  const snapshot = () => ({ ...hits })
  const delta = (before) => ({
    anchorQueries: hits.rows + hits.trees - before.rows - before.trees,
    styles: hits.styles - before.styles,
  })

  try {
    const keeper = createAnchorKeeper({ onAttach: () => {}, missDelayMs: 6000 })
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await wait(400)

    const node = realQuery.call(document, '[data-probe-anchor="block"]')
    const row = realQuery.call(document, '[data-row-key]')
    let list = null
    if (row !== null) {
      let element = row.parentElement
      while (element !== null && element !== document.body) {
        if (realStyle.call(window, element).overflowY === 'auto') { list = element; break }
        element = element.parentElement
      }
    }
    const treeBody = list === null ? null : list.parentElement
    const listArea = treeBody === null ? null : treeBody.parentElement
    report.attached = node !== null && node.isConnected
    report.placement = node !== null && treeBody !== null && node.nextElementSibling === treeBody
      ? 'immediately-before-scroll-container'
      : String(node === null ? 'no-node' : node.nextElementSibling === null ? 'last-child' : 'wrong-slot')
    report.listAreaChildren = listArea === null ? -1 : listArea.children.length

    const baseline = snapshot()
    await wait(3000)
    report.idle = delta(baseline)
    report.otherQueriesPerIdle = hits.other - baseline.other

    const before = snapshot()
    for (let round = 0; round < 40; round += 1) {
      const filler = document.createElement('div')
      list.appendChild(filler)
      list.removeChild(filler)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    report.listChurn = delta(before)

    /* What a React re-render of the browser root looks like from here: the
       scroll container is re-appended under the region we observe. */
    const rebuildBefore = snapshot()
    listArea.appendChild(treeBody)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await wait(120)
    report.rebuildDelta = delta(rebuildBefore)
    report.rebuildReplaced =
      node.nextElementSibling === treeBody && node.parentElement === listArea

    const hitBefore = snapshot()
    document.documentElement.appendChild(document.createElement('span'))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await wait(120)
    report.bodyChurn = delta(hitBefore)

    keeper.dispose()
    await wait(50)
    report.disposed = realQuery.call(document, '[data-probe-anchor="block"]') === null
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
  } finally {
    Document.prototype.querySelector = realQuery
    window.getComputedStyle = realStyle
  }
  return report
}
`

const target = join(tmpdir(), 'dsh-anchor-probe.js')
writeFileSync(target, probe, 'utf8')
process.stdout.write(`${target}\n${probe.length} bytes\n`)
