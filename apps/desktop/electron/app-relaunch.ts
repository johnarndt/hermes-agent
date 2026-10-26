import type { RelaunchOptions } from 'electron'

import { LAUNCHER_READY_FD_ENV } from './linux-launcher-ready'
import { restoreLaunchTmpdir } from './linux-sandbox-relaunch'
import { canRelaunch, relaunchNow, relaunchTarget } from './relaunch-target'

interface RelaunchHost {
  relaunch(options: RelaunchOptions): void
}

/**
 * Every self-relaunch (GPU or sandbox fallback, update swap) goes through here.
 * The launcher's ready pipe is not inherited by the relaunched process, so a
 * carried `HERMES_DESKTOP_READY_FD` names whatever file reuses that descriptor
 * number there, and the reveal byte would be written into it.
 */
export function relaunchApp(host: RelaunchHost, options: RelaunchOptions, env: NodeJS.ProcessEnv = process.env): void {
  delete env[LAUNCHER_READY_FD_ENV]
  host.relaunch(options)
}

export interface AppRelauncher {
  commandLine: { hasSwitch(name: string): boolean }
  relaunch(options: RelaunchOptions): void
  releaseSingleInstanceLock(): void
  exit(code: number): void
}

/**
 * The `app` every relaunch site and the final exit go through.
 *
 * On Linux, Electron's relauncher starts the new process with
 * PR_SET_NO_NEW_PRIVS, which every descendant inherits: the backend and the
 * agent's terminal can no longer use sudo, pkexec or any setuid helper, and a
 * FUSE-mounted AppImage cannot mount itself again. Linux therefore only
 * records the relaunch, and `exit()` starts the target as an ordinary detached
 * child right before exiting, after the backend is down and the
 * single-instance lock is dropped, so the child neither races the old backend
 * nor quits as a second instance. The target is the AppImage file for a
 * mounted image (the mount dies with this process), otherwise this executable.
 */
export function createAppRelauncher(
  app: AppRelauncher,
  platform: NodeJS.Platform | string = process.platform,
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): AppRelauncher {
  if (platform !== 'linux') {
    return app
  }

  let pendingArgs: string[] | null = null
  // JS keeps running for a moment after app.exit(); a relaunch requested then would start a second child.
  let exiting = false

  return {
    commandLine: app.commandLine,
    releaseSingleInstanceLock: () => app.releaseSingleInstanceLock(),
    relaunch: options => {
      if (!exiting) {
        pendingArgs = options.args ?? process.argv.slice(1)
      }
    },
    exit: code => {
      exiting = true

      try {
        if (pendingArgs) {
          // The new process skips `hermes desktop`: it needs the launcher's short socket TMPDIR,
          // not the long one main.ts restored after the lock (linux-sandbox-relaunch.ts).
          const childEnv = { ...env }
          restoreLaunchTmpdir(childEnv)
          const target = relaunchTarget(execPath, env)

          if (canRelaunch(target, 'relaunching through Electron instead', childEnv)) {
            relaunchNow(app, pendingArgs, target, childEnv)
          } else {
            // The backend is already down: Electron's relauncher is the last way back.
            app.relaunch({ args: pendingArgs })
          }

          pendingArgs = null
        }
      } finally {
        // A synchronous spawn throw (E2BIG) must not leave the app running with its lock released.
        app.exit(code)
      }
    }
  }
}
