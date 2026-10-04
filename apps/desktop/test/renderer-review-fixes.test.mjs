import { readAppSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, path), "utf8");
const app = readAppSourceSync();
const rendererApi = read("../src/capture/renderer-api.ts");
const captureRig = read("../src/capture/capture-rig.ts");
const main = read("../src/main.tsx");
const windowControls = read("../src/components/WindowControls.tsx");
const messages = read("../src/styles/messages.css");

test("screenshot fixtures stay out of the production App bundle", () => {
  // App only mounts the tiny automation surface; the fixtures are a separate
  // module reached through a dynamic import.
  assert.match(app, /useEffect\(\(\) => installRendererApi\(\), \[\]\);/);
  assert.doesNotMatch(app, /__PI_CAPTURE__|seedTranscript|ensureVisualFixtures|\(api as any\)/);
  assert.match(rendererApi, /import\("\.\/capture-rig"\)/);
  assert.match(rendererApi, /^import type \{[^}]*\} from "\.\/capture-rig";/m);
  assert.doesNotMatch(rendererApi, /^import \{[^}]*\} from "\.\/capture-rig";/m);
  // The e2e runner and capture suite reach these without any flag set.
  for (const name of [
    "setPage",
    "selectSession",
    "setSettingsTab",
    "showToast",
    "clearProject",
    "setThemeAttr",
    "refreshProviders",
  ]) {
    assert.match(rendererApi, new RegExp(`^    ${name}: `, "m"), name);
  }
  // Fixture stubs refuse to load the rig unless the capture flag is set, and
  // every fixture in the rig re-checks it before touching state.
  assert.match(rendererApi, /if \(!window\.__PI_CAPTURE__\) return undefined;/);
  const guards = captureRig.match(/if \(!window\.__PI_CAPTURE__\) return/g) ?? [];
  const fixtures = captureRig.match(/^    (?:seed\w+|ensureVisualFixtures|openWorkPanel\w*|collapseWorkPanel): /gm) ?? [];
  assert.ok(fixtures.length >= 13, `expected the fixture methods, saw ${fixtures.length}`);
  assert.ok(guards.length >= fixtures.length, "every fixture checks __PI_CAPTURE__");
  // Restoring the monkey-patched api.* calls is part of tearing the rig down.
  assert.match(captureRig, /dispose: \(\) => \{[\s\S]*api\.listPluginServices = originalListPluginServices;/);
});

test("the crash fallback never interprets the error as markup", () => {
  assert.doesNotMatch(main, /innerHTML/);
  assert.match(main, /detail\.textContent = String\(error\);/);
  assert.match(main, /heading\.textContent = i18n\.t\("app\.uiCrashed"/);
});

test("window controls draw through the icon wrappers", () => {
  assert.doesNotMatch(windowControls, /from "lucide-react"/);
  assert.match(windowControls, /import \{ IconClose, IconCopy, IconMinus, IconSquare \} from "\.\/icons";/);
});


test("message image chips carry no tile or stroke of their own (D297)", () => {
  const start = messages.indexOf(".message-attachment-image-chip {");
  assert.notEqual(start, -1, "message image chip rule is missing");
  const block = messages.slice(start, messages.indexOf("}", start));
  // The shared composer chip and the preview card own the surface; the wrapper
  // stays a bare inline layout box.
  assert.doesNotMatch(block, /background:|border|box-shadow/);
  assert.match(block, /display: inline-flex;/);
});

test("dead components are gone", () => {
  assert.ok(!existsSync(join(here, "../src/components/Topbar.tsx")));
  assert.ok(!existsSync(join(here, "../src/components/HomeQuickActions.tsx")));
});
