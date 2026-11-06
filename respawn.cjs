'use strict'

/**
 * Restart helper for dsh-active-sessions.
 *
 * The host cannot respawn itself: it has to exit before the port is free and the
 * same command line can come back. So `update.restart()` base64-encodes the job
 * into argv and starts this file detached, then exits. This file waits for the old
 * pid to disappear, waits for the port to be released, and starts the command
 * again with the caller's environment.
 */

const { spawn } = require('node:child_process')
const { appendFileSync, mkdirSync, openSync, closeSync } = require('node:fs')
const net = require('node:net')
const { dirname } = require('node:path')

const PAYLOAD = process.argv[2]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodePayload(raw) {
  if (typeof raw !== 'string' || raw === '') throw new Error('missing payload')
  const text = Buffer.from(raw, 'base64').toString('utf8')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed.argv) || parsed.argv.length === 0) throw new Error('payload has no argv')
  return parsed
}

let logPath

function logLine(text) {
  if (logPath === undefined) return
  try {
    appendFileSync(logPath, `[respawn ${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch {
    // Logging must never take the restart down.
  }
}

function alive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(150)
  }
  return !alive(pid)
}

function portFree(port) {
  return new Promise((resolve) => {
    if (typeof port !== 'number' || port <= 0) {
      resolve(true)
      return
    }
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(600)
    socket.once('connect', () => done(false))
    socket.once('timeout', () => done(true))
    socket.once('error', () => done(true))
  })
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(port)) return true
    await sleep(200)
  }
  return await portFree(port)
}

async function main() {
  const payload = decodePayload(PAYLOAD)
  logPath = typeof payload.log === 'string' && payload.log !== '' ? payload.log : undefined
  if (logPath !== undefined) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
    } catch {}
  }
  logLine(`waiting for pid ${payload.pid} to exit`)

  if (!(await waitForExit(payload.pid, 30000))) {
    logLine('the old process did not exit in time; giving up')
    process.exit(1)
  }
  if (!(await waitForPort(payload.port, 20000))) {
    logLine(`port ${payload.port} is still held; starting anyway`)
  }
  await sleep(400)

  const [command, ...args] = payload.argv
  let fd
  try {
    fd = openSync(logPath, 'a')
  } catch {
    fd = undefined
  }

  let child
  try {
    logLine(`starting: ${command} ${args.join(' ')}`)
    child = spawn(command, args, {
      cwd: payload.cwd,
      env: payload.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    })
  } catch (error) {
    logLine(`spawn failed: ${String(error)}`)
    process.exit(1)
  } finally {
    // Closing the descriptor before spawn hands a closed fd to the child, which
    // fails as EBADF with no output anywhere. Close it only after the spawn.
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }

  child.on('error', (error) => logLine(`child error: ${String(error)}`))
  child.unref()

  await sleep(1500)
  if (child.exitCode !== null) {
    logLine(`the new process exited immediately with code ${String(child.exitCode)}`)
    process.exit(1)
  }
  await sleep(200)
  logLine('restart handed off')
  process.exit(0)
}

main().catch((error) => {
  logLine(`unexpected failure: ${String(error)}`)
  process.exit(1)
})
