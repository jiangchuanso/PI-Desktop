import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { initialConfigSyncForm, configSyncTestInput, configSyncConfigureInput, clearConfigSyncFormSecrets, selectionFromDraft, draftFromForm, draftFromState } = await import("../src/features/settings/config-sync-form.ts");

const selection = selectionFromDraft();
const input = (form) => configSyncTestInput(form, selection, "This device");

test("blank credentials mean reuse; replacement and clearing are explicit", () => {
  const form = initialConfigSyncForm();
  assert.equal(input(form).secretAccessKey, undefined);
  assert.equal(input(form).sessionToken, undefined);
  assert.equal(input({ ...form, secretAccessKey: " exact secret " }).secretAccessKey, " exact secret ");
  assert.equal(input({ ...form, secretAccessKey: "replacement" }).sessionToken, "");
  assert.equal(input({ ...form, sessionToken: "temporary" }).sessionToken, "temporary");
  assert.equal(input({ ...form, sessionToken: "temporary", clearSessionToken: true }).sessionToken, "");
});

test("test and save share choices but never send vault passwords in a probe", () => {
  const form = { ...initialConfigSyncForm(), endpoint: " https://s3.example.com ", bucket: "private",
    secretAccessKey: "secret", sessionToken: "token", backupPassword: " password ",
    currentBackupPassword: "current", newBackupPassword: "new", mode: "backup", automaticSync: false };
  const probe = input(form);
  const saved = configSyncConfigureInput(form, selection, "This device");
  assert.deepEqual(saved, { ...probe, backupPassword: " password " });
  assert.equal(probe.endpoint, "https://s3.example.com");
  assert.equal(probe.mode, "backup");
  assert.equal(probe.automaticSync, false);
  assert.equal(probe.includeSecrets, false);
  assert.equal(probe.includeMemory, false);
  assert.doesNotMatch(JSON.stringify(probe), /[Pp]assword|current|newBackup/);
  assert.doesNotMatch(JSON.stringify(draftFromForm(form, selection)), /secretAccessKey|sessionToken|[Pp]assword/);
  const cleared = clearConfigSyncFormSecrets(form);
  for (const key of ["secretAccessKey", "sessionToken", "backupPassword", "currentBackupPassword", "newBackupPassword"]) assert.equal(cleared[key], "");
  assert.equal(cleared.bucket, form.bucket);
});

test("saved choices hydrate without turning off opt-ins or turning on automatic runs", () => {
  const state = { ...initialConfigSyncForm(), automaticSync: false, categories: selection,
    includeSecrets: true, includeMemory: true, mode: "backup" };
  const draft = draftFromState(state);
  const form = initialConfigSyncForm(draft);
  assert.equal(form.automaticSync, false);
  assert.equal(form.mode, "backup");
  assert.equal(draft.categories.credentials, true);
  assert.equal(draft.categories.memory, true);
  assert.equal(draft.saved, true);
});
