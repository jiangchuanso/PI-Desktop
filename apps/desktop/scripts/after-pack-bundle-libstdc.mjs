#!/usr/bin/env node
/**
 * electron-builder afterPack hook — Linux only.
 *
 * Electron 43's bundled Chromium links against a newer libstdc++ than Ubuntu
 * 20.04 / 银河麒麟 V10 SP1 ship (GCC 9 → GLIBCXX_3.4.28), so the app aborts on
 * launch with `version 'GLIBCXX_3.4.xx' not found`. To stay on Electron 43 we
 * bundle a newer libstdc++.so.6 next to the executable and inject it via an
 * LD_LIBRARY_PATH wrapper, leaving the glibc floor (2.31) untouched.
 *
 * The bundled lib is produced by the CI container build (the Linux workflows):
 * it compiles a recent GCC's libstdc++ on an Ubuntu 20.04 base, so the bundled
 * lib itself only needs glibc 2.31. CI passes its path via PI_BUNDLED_LIBSTDCXX;
 * otherwise we fall back to the build host's system lib for the target arch,
 * which we read from the ELF header (no electron-builder import needed).
 *
 * This hook lives inside apps/desktop because electron-builder refuses a hook
 * path that resolves outside the package's workspace root.
 *
 * We do not hardcode a GLIBCXX version: the required version is read from the
 * app's ELF binaries and asserted against what the bundled lib provides, so the
 * check keeps working as Electron raises its C++ ABI requirement.
 *
 * The Rust host-core glibc floor is enforced separately by
 * scripts/check-linux-host-glibc.mjs.
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

// ELF e_machine → system libstdc++.so.6 on the build host (fallback only).
const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const MACHINE_LIB = {
  [EM_X86_64]: "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
  [EM_AARCH64]: "/usr/lib/aarch64-linux-gnu/libstdc++.so.6",
};

/** ELF e_machine for a file, or null when it is not an ELF binary. */
function elfMachine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const header = Buffer.alloc(20);
    const read = readSync(fd, header, 0, 20, 0);
    if (read < 20) return null;
    if (
      !(
        header[0] === 0x7f &&
        header[1] === 0x45 &&
        header[2] === 0x4c &&
        header[3] === 0x46
      )
    ) {
      return null;
    }
    return header[5] === 1
      ? header.readUInt16LE(18)
      : header.readUInt16BE(18);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(child);
    else yield child;
  }
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Highest `GLIBCXX_x.y.z` string referenced or provided in a blob of text. */
function maxGlibcxx(text) {
  let max = null;
  for (const match of text.matchAll(/GLIBCXX_(\d+)\.(\d+)\.(\d+)/g)) {
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!max || compareVersion(version, max) > 0) max = version;
  }
  return max;
}

/** Highest `GLIBCXX_x.y.z` required by any ELF binary under the app dir. */
function requiredGlibcxx(appDir) {
  let required = null;
  for (const file of walkFiles(appDir)) {
    if (elfMachine(file) === null) continue;
    const found = maxGlibcxx(readFileSync(file, "latin1"));
    if (found && (!required || compareVersion(found, required) > 0)) {
      required = found;
    }
  }
  return required;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const appDir = context.appOutDir;
  const binName =
    context.packager?.info?.options?.linux?.executableName ||
    context.packager?.executableName ||
    context.packager?.appInfo?.productFilename ||
    "pi-desktop";
  const exePath = join(appDir, binName);
  const realBin = `${exePath}.bin`;
  const libDir = join(appDir, "lib");
  const libDest = join(libDir, "libstdc++.so.6");

  const exeIsElf = elfMachine(exePath) !== null;
  const realIsElf = elfMachine(realBin) !== null;
  if (!exeIsElf && !realIsElf) {
    throw new Error(`afterPack: expected an ELF executable at ${exePath}.`);
  }

  // Pick the lib to bundle: CI-provided (glibc-2.31-compatible GCC lib) or the
  // build host's system lib matching the target architecture.
  const envLib = process.env.PI_BUNDLED_LIBSTDCXX;
  let src = envLib && existsSync(envLib) ? envLib : null;
  if (!src) {
    const machine = elfMachine(exeIsElf ? exePath : realBin);
    src = MACHINE_LIB[machine] ?? null;
  }
  if (!src || !existsSync(src)) {
    throw new Error(
      `afterPack: no libstdc++.so.6 to bundle${src ? ` (${src} missing)` : ""}; ` +
        "set PI_BUNDLED_LIBSTDCXX to a recent GCC libstdc++.so.6, or install " +
        "libstdc++6 on the build host.",
    );
  }

  // Bundle the lib, then verify it satisfies every GLIBCXX the app's ELF
  // binaries reference (Electron 43 needs a newer ABI than 20.04 ships).
  mkdirSync(libDir, { recursive: true });
  copyFileSync(src, libDest);
  const provided = maxGlibcxx(readFileSync(libDest, "latin1"));
  const required = requiredGlibcxx(appDir);
  if (required && (!provided || compareVersion(provided, required) < 0)) {
    const fmt = (v) => (v ? v.join(".") : "none");
    throw new Error(
      `afterPack: ${src} provides GLIBCXX_${fmt(provided)} but the app needs ` +
        `GLIBCXX_${fmt(required)}; bundle a newer libstdc++6 (GCC >= 12).`,
    );
  }

  // Move the real ELF aside and replace it with an LD_LIBRARY_PATH wrapper so
  // Chromium and its child processes (which inherit the env) load the bundled
  // lib. Renaming keeps Electron's resource resolution working because it is
  // based on the executable's directory, not its name. Idempotent: a second
  // afterPack pass sees the wrapper, not the ELF, and skips the rename.
  if (exeIsElf) {
    if (existsSync(realBin)) {
      throw new Error(`afterPack: ${realBin} already exists; aborting.`);
    }
    renameSync(exePath, realBin);
  }

  const wrapper = [
    "#!/bin/sh",
    'HERE="$(dirname "$(readlink -f "$0")")"',
    'export LD_LIBRARY_PATH="$HERE/lib:$LD_LIBRARY_PATH"',
    `exec "$HERE/${binName}.bin" "$@"`,
    "",
  ].join("\n");
  writeFileSync(exePath, wrapper);
  chmodSync(exePath, 0o755);
  if (existsSync(realBin)) chmodSync(realBin, 0o755);
}
