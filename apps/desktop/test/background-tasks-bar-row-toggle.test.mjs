import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The row body of the background-tasks bar toggles the log, not only the
 * "output" button: the clickable surface is the whole row lead (state dot,
 * command, meta), while stop / dismiss keep their own behavior.
 */

const [bar, composerStyles] = await Promise.all([
  readFile(new URL("../src/components/BackgroundTasksBar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8"),
]);

test("the row body is an interactive element that toggles the log", () => {
  const main = bar.match(
    /<div\s+className="background-task-main"[\s\S]*?<\/div>/,
  );
  assert.ok(main, "row body element missing");
  assert.match(main[0], /role="button"/);
  assert.match(main[0], /tabIndex=\{0\}/);
  assert.match(main[0], /aria-expanded=\{isExpanded\}/);
  assert.match(main[0], /onClick=\{\(\) => void toggleOutput\(task\.id\)\}/);
  // Keyboard parity with a real button.
  assert.match(main[0], /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(main[0], /if \(event\.target !== event\.currentTarget\) return;/);
});

test("the toggle surface covers the state dot, command and meta rows", () => {
  const main = bar.match(
    /<div\s+className="background-task-main"[\s\S]*?<\/div>/,
  )[0];
  for (const className of ["background-task-state", "background-task-command", "background-task-meta"]) {
    assert.match(main, new RegExp(`className="${className}"`));
  }
});

test("stop and dismiss stay outside the toggle surface", () => {
  const toggleEnd = bar.indexOf('className="background-task-main"');
  const stopAt = bar.indexOf('background-task-action is-stop"');
  const dismissAt = bar.indexOf('onClick={() => dismiss(task.id)}');
  assert.ok(stopAt > toggleEnd && dismissAt > toggleEnd);
  // Exactly one projection button remains.
  assert.equal(bar.match(/t\("backgroundTasks\.output"\)/g)?.length, 1);
});

test("the row styles keep the body clickable and focus-visible", () => {
  assert.match(
    composerStyles,
    /\.background-task-main\s*\{[^{}]*flex: 1 1 auto/,
  );
  assert.match(composerStyles, /\.background-task-main\s*\{[^{}]*cursor: pointer/);
  assert.match(
    composerStyles,
    /\.background-task-main:focus-visible\s*\{[^{}]*outline: 2px solid var\(--ds-focus\)/,
  );
});
