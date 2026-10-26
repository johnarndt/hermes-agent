import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { createAppRelauncher, relaunchApp } from './app-relaunch'
import { LAUNCHER_READY_FD_ENV } from './linux-launcher-ready'

test('a self-relaunch never hands the launcher ready-pipe fd number to the new process', () => {
  const env: NodeJS.ProcessEnv = { [LAUNCHER_READY_FD_ENV]: '4', KEEP: '1' }
  const seen: Array<{ args?: string[]; carried: string | undefined }> = []

  relaunchApp({ relaunch: options => seen.push({ args: options.args, carried: env[LAUNCHER_READY_FD_ENV] }) }, { args: ['--disable-gpu'] }, env)

  expect(seen).toEqual([{ args: ['--disable-gpu'], carried: undefined }])
  expect(env.KEEP).toBe('1')
})

function recordingApp(events: string[]) {
  return {
    commandLine: { hasSwitch: () => false },
    relaunch: (options: { args?: string[] }) => events.push(`relaunch ${options.args?.join(' ')}`),
    releaseSingleInstanceLock: () => events.push('release'),
    exit: (code: number) => events.push(`exit ${code}`)
  }
}

function noNewPrivs(statusText: string): string | undefined {
  return /^NoNewPrivs:\s*(\d)/m.exec(statusText)?.[1]
}

// Electron's Linux relauncher sets PR_SET_NO_NEW_PRIVS on the new process; the backend and
// the agent's terminal inherit it and sudo refuses. The new process must be an ordinary child.
test.skipIf(process.platform !== 'linux')(
  'a Linux relaunch starts this executable at exit, unlocked, in its own session, without no_new_privs',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-relaunch-'))
    const report = path.join(dir, 'report')
    const exe = path.join(dir, 'hermes')
    const events: string[] = []

    fs.writeFileSync(
      exe,
      `#!/bin/sh\nprintf '%s\\n' "$*" "$(cut -d' ' -f6 /proc/$$/stat) $$" "$(grep NoNewPrivs /proc/$$/status)" > "${report}.part"\nmv "${report}.part" "${report}"\n`,
      { mode: 0o755 }
    )

    try {
      const env = { PATH: process.env.PATH, [LAUNCHER_READY_FD_ENV]: '4' }
      const relauncher = createAppRelauncher(recordingApp(events), 'linux', exe, env)

      relaunchApp(relauncher, { args: ['--disable-gpu'] }, env)
      // Scheduled only: the old process still owns the lock, its windows and the backend.
      expect(events).toEqual([])

      relauncher.exit(0)

      await vi.waitFor(() => expect(fs.existsSync(report)).toBe(true), { timeout: 5000 })
      const [args, session, privs] = fs.readFileSync(report, 'utf8').split('\n')
      const [sid, pid] = session.split(' ')

      expect(events).toEqual(['release', 'exit 0'])
      expect(args).toBe('--disable-gpu')
      expect(sid).toBe(pid)
      expect(noNewPrivs(privs)).toBe(noNewPrivs(fs.readFileSync('/proc/self/status', 'utf8')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('macOS and Windows keep Electron app.relaunch', () => {
  for (const platform of ['darwin', 'win32']) {
    const events: string[] = []
    const relauncher = createAppRelauncher(recordingApp(events), platform, '/nonexistent/hermes', {})

    relaunchApp(relauncher, { args: ['--no-sandbox'] }, {})
    relauncher.exit(0)

    expect(events).toEqual(['relaunch --no-sandbox', 'exit 0'])
  }
})

// The exit path runs after the backend is down: a target that cannot start falls back to
// Electron's relauncher. JS keeps running briefly after app.exit(), and a relaunch requested
// then (a second Restart) must not start another process.
test.skipIf(process.platform !== 'linux')('a Linux relaunch whose target cannot start uses Electron, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-relaunch-noexec-'))
  const exe = path.join(dir, 'hermes')
  const events: string[] = []
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

  fs.writeFileSync(exe, '', { mode: 0o644 })

  try {
    const relauncher = createAppRelauncher(recordingApp(events), 'linux', exe, { PATH: process.env.PATH })

    relaunchApp(relauncher, { args: ['--disable-gpu'] }, {})
    relauncher.exit(0)
    relaunchApp(relauncher, { args: ['--no-sandbox'] }, {})
    relauncher.exit(0)

    expect(events).toEqual(['relaunch --disable-gpu', 'exit 0', 'exit 0'])
    expect(logged).toHaveBeenCalledTimes(1)
  } finally {
    logged.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
