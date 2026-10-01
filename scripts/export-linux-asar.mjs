import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

/** electron-builder's unpacked dir name for a Linux arch (x64 keeps no suffix). */
function archOfUnpackedDir(name) {
  return name === "linux-unpacked"
    ? "x64"
    : name.replace(/^linux-/, "").replace(/-unpacked$/, "");
}

/**
 * Find the app.asar electron-builder produced. The x64 dir is `linux-unpacked`;
 * other arches get a suffix (`linux-arm64-unpacked`). Each CI job builds one
 * arch, so the first match wins.
 */
async function findLinuxUnpackedAsar(rootDir) {
  const releaseDir = join(rootDir, "apps/desktop/release");
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(
    () => [],
  );
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === "linux-unpacked" || /^linux-.+-unpacked$/.test(name))
    // x64 (`linux-unpacked`) first, then the arch-suffixed dirs.
    .sort((a, b) => Number(a !== "linux-unpacked") - Number(b !== "linux-unpacked"));
  for (const name of names) {
    const source = join(releaseDir, name, "resources/app.asar");
    if ((await stat(source).catch(() => null))?.isFile()) {
      return { source, arch: archOfUnpackedDir(name) };
    }
  }
  return null;
}

/**
 * Export the Linux app archive produced by electron-builder as a named release
 * asset. The archive is intentionally copied instead of repacked so the asset
 * is byte-identical to the app.asar used by the AppImage and deb outputs.
 */
export async function exportLinuxAsar({
  rootDir = repositoryRoot,
  version,
  sourcePath,
  arch,
  outputDir,
} = {}) {
  const packagePath = join(rootDir, "apps/desktop/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const releaseVersion = version ?? packageJson.version;
  if (typeof releaseVersion !== "string" || releaseVersion.trim() === "") {
    throw new Error(`Missing desktop package version in ${packagePath}`);
  }

  let source = sourcePath;
  let resolvedArch = arch;
  if (!source) {
    const found = await findLinuxUnpackedAsar(rootDir);
    if (!found) {
      throw new Error(
        "Linux ASAR source not found: apps/desktop/release/linux-unpacked/resources/app.asar",
      );
    }
    source = found.source;
    resolvedArch = resolvedArch ?? found.arch;
  }
  resolvedArch = resolvedArch ?? "x64";

  const destinationDirectory =
    outputDir ?? join(rootDir, "apps/desktop/release");
  const sourceStats = await stat(source).catch(() => null);
  if (!sourceStats?.isFile()) {
    throw new Error(`Linux ASAR source not found: ${source}`);
  }

  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(
    destinationDirectory,
    `PI-Desktop-${releaseVersion}-linux-${resolvedArch}.asar`,
  );
  await copyFile(source, destination);
  return { source, destination, version: releaseVersion, arch: resolvedArch };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  try {
    const result = await exportLinuxAsar();
    console.log(`Exported ${result.destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
