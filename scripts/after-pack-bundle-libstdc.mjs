#!/usr/bin/env node
/**
 * electron-builder afterPack hook — Linux only.
 *
 * Electron 43's bundled Chromium links against libstdc++ from GCC 11+, which
 * provides GLIBCXX_3.4.30. Ubuntu 20.04 / 银河麒麟 V10 SP1 (the oldest target,
 * glibc 2.31) only ship GCC 9's libstdc++6 (GLIBCXX_3.4.28), so the app aborts
 * on launch with `version 'GLIBCXX_3.4.30' not found`. To stay on Electron 43
 * we bundle a newer libstdc++.so.6 next to the executable and inject it via an
 * LD_LIBRARY_PATH wrapper, leaving the glibc floor (2.31) untouched.
 *
 * The bundled lib is produced by the CI container build (the Linux workflows):
 * it compiles a GCC 12 libstdc++ on an Ubuntu 20.04 base, so the bundled lib
 * itself only needs glibc 2.31. CI passes its path via PI_BUNDLED_LIBSTDCXX;
 * otherwise we fall back to the build host's system libstdc++.so.6.
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
} from "node:fs";
import { join } from "node:path";
import { Arch } from "electron-builder";

// System libstdc++.so.6 path on the build host, per target architecture.
// Used only as a fallback when PI_BUNDLED_LIBSTDCXX is not provided.
const MULTIARCH_LIB = {
  [Arch.x64]: "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
  [Arch.arm64]: "/usr/lib/aarch64-linux-gnu/libstdc++.so.6",
};

export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const envLib = process.env.PI_BUNDLED_LIBSTDCXX;
  const src = envLib && existsSync(envLib) ? envLib : MULTIARCH_LIB[context.arch];
  if (!src) {
    throw new Error(`afterPack: no bundled libstdc++ path for arch ${context.arch}`);
  }
  if (!existsSync(src)) {
    throw new Error(
      `afterPack: ${src} not found — provide PI_BUNDLED_LIBSTDCXX (a GCC 12+ ` +
        "libstdc++.so.6) or install libstdc++6 on the build host.",
    );
  }

  const appDir = context.appOutDir;
  const binName =
    context.packager.info.options.linux?.executableName ?? "pi-desktop";
  const exePath = join(appDir, binName);
  const realBin = `${exePath}.bin`;
  const libDir = join(appDir, "lib");
  const libDest = join(libDir, "libstdc++.so.6");

  if (!existsSync(exePath)) {
    throw new Error(`afterPack: expected executable ${exePath} not found.`);
  }

  mkdirSync(libDir, { recursive: true });
  copyFileSync(src, libDest);

  // The bundled lib must actually provide the newer C++ ABI, otherwise we
  // would ship an old lib and the crash would remain.
  const bundled = readFileSync(libDest, "latin1");
  if (!/GLIBCXX_3\.4\.30/.test(bundled)) {
    throw new Error(
      `afterPack: ${src} does not provide GLIBCXX_3.4.30; bundle a newer ` +
        "libstdc++6 (GCC >= 12).",
    );
  }

  // Move the real ELF binary aside and replace it with an LD_LIBRARY_PATH
  // wrapper. Chromium child processes inherit the env, so they pick up the
  // bundled lib too. Renaming keeps Electron's resource resolution working
  // because it is based on the executable's directory, not its name.
  if (existsSync(realBin)) {
    throw new Error(`afterPack: ${realBin} already exists; aborting.`);
  }
  renameSync(exePath, realBin);

  const wrapper = [
    "#!/bin/sh",
    'HERE="$(dirname "$(readlink -f "$0")")"',
    'export LD_LIBRARY_PATH="$HERE/lib:$LD_LIBRARY_PATH"',
    `exec "$HERE/${binName}.bin" "$@"`,
    "",
  ].join("\n");
  writeFileSync(exePath, wrapper);
  chmodSync(exePath, 0o755);
  chmodSync(realBin, 0o755);
}
