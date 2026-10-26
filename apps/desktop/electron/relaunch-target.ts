import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// AppImage is Linux-only; POSIX semantics keep the answer identical on every test host.
const posix = path.posix

function isInside(dir: string, file: string): boolean {
  const inside = posix.relative(dir, file)

  return Boolean(inside) && !inside.startsWith('..') && !posix.isAbsolute(inside)
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/**
 * The AppImage file this executable runs from, or undefined when it is not one.
 *
 * The AppImage runtime exports APPIMAGE/APPDIR to every descendant: Hermes
 * started from a terminal or IDE AppImage inherits that app's values, and
 * acting on them would relaunch, or rm -rf on uninstall, the other app.
 * APPIMAGE is ours only when this executable runs from that image's mount:
 * - inside APPDIR when it is set (the FUSE mount, or the
 *   `appimage_extracted_<hash>` dir of --appimage-extract-and-run);
 * - otherwise inside a type-2 runtime mount, `$TMPDIR/.mount_<name><random>`
 *   (AppImage/type2-runtime src/runtime/runtime.c build_mount_point():
 *   "%s/.mount_%.*sXXXXXX", then mkdtemp).
 */
export function ownAppImage(execPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const { APPDIR: appDir, APPIMAGE: appImage } = env

  if (!appImage || !execPath) {
    return undefined
  }

  const exe = posix.resolve(execPath)

  if (!appDir) {
    return posix.dirname(exe).split('/').some(segment => segment.startsWith('.mount_')) ? appImage : undefined
  }

  if (isInside(posix.resolve(appDir), exe)) {
    return appImage
  }

  // The runtime builds APPDIR from the raw $TMPDIR, while process.execPath has
  // its symlinks resolved: TMPDIR=~/tmp on Fedora Atomic (/home -> /var/home).
  const realAppDir = realpathOrNull(appDir)
  const realExe = realpathOrNull(exe)

  return realAppDir && realExe && isInside(realAppDir, realExe) ? appImage : undefined
}

/**
 * The file that starts this app again.
 *
 * process.execPath of a FUSE-mounted AppImage lives in this process's mount,
 * which the runtime unmounts as soon as we exit, so a mounted image relaunches
 * its image file. Under --appimage-extract-and-run APPDIR is a plain directory
 * and the image would need the FUSE those users lack, so the executable in it
 * is relaunched as usual.
 */
export function relaunchTarget(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  const image = ownAppImage(execPath, env)
  const extracted = env.APPDIR && posix.basename(posix.resolve(env.APPDIR)).startsWith('appimage_extracted_')

  return image && !extracted ? image : execPath
}

function executableError(file: string): string | null {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error)
  }
}

/**
 * The shell that runs EXEC_AFTER_EXIT. dash (Debian/Ubuntu /bin/sh)
 * cannot name fds above 9, and after `ready` Chromium holds dozens there, so
 * bash closes them where it exists. `-p` keeps BASH_ENV, ENV and exported
 * functions from running in it while still passing them to the image; bash
 * rewrites an exported SHELLOPTS/BASHOPTS for its children, so an env that
 * carries one keeps /bin/sh.
 */
function trampolineShell(env: NodeJS.ProcessEnv): { file: string; args: string[]; fallback?: string } {
  const bashOptsExported = env.SHELLOPTS !== undefined || env.BASHOPTS !== undefined

  if (!bashOptsExported && !executableError('/bin/bash')) {
    return { file: '/bin/bash', args: ['-p'] }
  }

  return {
    file: '/bin/sh',
    args: [],
    fallback: bashOptsExported ? 'SHELLOPTS/BASHOPTS exported' : '/bin/bash unavailable'
  }
}

/**
 * Whether `target` can start this app again. A spawn failure is reported
 * asynchronously, possibly after the caller has exited, so the target and the
 * shell that starts it are checked up front and a refusal is logged now with
 * what the caller does instead.
 */
export function canRelaunch(
  target: string,
  instead = 'continuing without the relaunch',
  env: NodeJS.ProcessEnv = process.env
): boolean {
  for (const file of [target, trampolineShell(env).file]) {
    const reason = executableError(file)

    if (reason) {
      console.error(`[hermes] cannot start ${file} (${reason}); ${instead}`)

      return false
    }
  }

  return true
}

// The helper starts before the caller's shutdown wait and execs the target
// once its stdin reaches EOF: that pipe's only writer is this process, so EOF
// is this process's exit, crash or kill, after which the target replaces the
// helper as Electron's relauncher would.
//
// libuv's spawn keeps every descriptor this process inherited without
// O_CLOEXEC, which Chromium's launcher (app.relaunch) closes. Ours include the
// AppImage runtime's keepalive pipe, whose last reader keeps this process's
// FUSE mount and squashfuse daemon alive, and the launcher's ready pipe. The
// child therefore goes through a shell (trampolineShell), which drops every fd
// above 2 and then execs the target. POSIX only promises redirections on fds
// 0-9 and dash exits on `exec 10<&-`, so higher numbers are closed where the
// shell takes them (bash, busybox) and left in place under dash.
const EXEC_AFTER_EXIT = `while read -r _; do :; done
exec </dev/null
big=
(eval 'exec 10<&-') 2>/dev/null && big=1
for f in /proc/self/fd/*; do
  n=\${f##*/}
  case $n in
    0 | 1 | 2 | '' | *[!0-9]*) continue ;;
    [3-9]) ;;
    *) [ -n "$big" ] || continue ;;
  esac
  eval "exec $n<&-"
done
exec "$0" "$@"`

/**
 * `env` without the PATH-style entries inside this mount, which the image's
 * AppRun prepended (PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS, ...). The new
 * image's AppRun prepends its own, while this mount goes away as soon as the
 * child stops holding it: a lookup through it while its FUSE daemon exits
 * fails with ENOTCONN, which aborted the new AppRun's `env bash`.
 */
function withoutMountEntries(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const appDir = env.APPDIR && posix.resolve(env.APPDIR)

  if (!appDir) {
    return env
  }

  const inMount = (entry: string) => entry === appDir || entry.startsWith(`${appDir}/`)
  const cleaned: NodeJS.ProcessEnv = { ...env }

  for (const [key, value] of Object.entries(env)) {
    const entries = value?.split(':') ?? []

    if (!entries.some(inMount)) {
      continue
    }

    const kept = entries.filter(entry => !inMount(entry)).join(':')

    if (kept) {
      cleaned[key] = kept
    } else {
      delete cleaned[key]
    }
  }

  return cleaned
}

/**
 * Start `target` with `args` once this process is gone, as an ordinary
 * detached child: Electron's relauncher execs with PR_SET_NO_NEW_PRIVS, which
 * locks sudo, pkexec and FUSE out of the new app and all its descendants.
 * Check `canRelaunch(target)` first; kill the returned helper to cancel.
 */
export function spawnRelaunch(target: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const shell = trampolineShell(env)

  if (shell.fallback) {
    console.warn(
      `[hermes] relaunching through /bin/sh (${shell.fallback}); file descriptors above 9 may stay open in the new process`
    )
  }

  const child = spawn(shell.file, [...shell.args, '-c', EXEC_AFTER_EXIT, target, ...args], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: withoutMountEntries(env)
  })

  child.on('error', error => console.error(`[hermes] relaunching ${target} failed: ${error.message}`))
  child.unref()

  return child
}
