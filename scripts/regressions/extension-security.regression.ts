import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonalExtensionSchema } from "../../packages/shared/src/schemas/personal-extension.schema.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { appSettings, installedExtensions } from "../../packages/server/src/db/schema/index.js";
import {
  getPersonalExtensionPolicy,
  setExternalExtensionsEnabled,
} from "../../packages/server/src/services/extensions/personal-extension-policy.service.js";
import { getPersonalExtensionSandboxStatus } from "../../packages/server/src/services/extensions/personal-extension-sandbox.js";
import { createPersonalExtensionSettingsStorage } from "../../packages/server/src/services/extensions/personal-extension-settings.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";
import { PersonalServerExtensionRuntime } from "../../packages/server/src/services/extensions/personal-server-extension-runtime.js";
import { getMariDbService } from "../../packages/server/src/services/mari-db/mari-db.service.js";
import { preparePersonalExtensionTrust } from "../../packages/server/src/services/setup/personal-extension-trust.js";
import { createAppSettingsStorage } from "../../packages/server/src/services/storage/app-settings.storage.js";

const readSource = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const clientInjectorSource = readSource("../../packages/client/src/components/layout/PersonalExtensionInjector.tsx");
const clientSettingsSource = readSource(
  "../../packages/client/src/components/panels/settings/PersonalExtensionsSettings.tsx",
);
const settingsPanelSource = readSource("../../packages/client/src/components/panels/SettingsPanel.tsx");
const clientHooksSource = readSource("../../packages/client/src/hooks/use-personal-extensions.ts");
const localizationSource = readSource("../../packages/client/src/localization/locales/en.json");
const routeSource = readSource("../../packages/server/src/routes/personal-extensions.routes.ts");
const runtimeSource = readSource(
  "../../packages/server/src/services/extensions/personal-server-extension-runtime.ts",
);
const sandboxSource = readSource("../../packages/server/src/services/extensions/personal-extension-sandbox.ts");
const schemaSource = readSource("../../packages/shared/src/schemas/personal-extension.schema.ts");
const backupSource = readSource("../../packages/server/src/routes/backup.routes.ts");
const professorMariSource = readSource("../../packages/server/src/services/professor-mari/workspace-agent.service.ts");

assert.match(
  localizationSource,
  /Ask Professor Mari to create an extension for you\. Nothing runs until you enable it and approve the exact code hash\./u,
);
assert.match(clientSettingsSource, /mode="personal"/u);
assert.match(clientSettingsSource, /mode="external"/u);
assert.match(clientSettingsSource, /isExternal && \(/u);
assert.match(clientSettingsSource, /settings\.externalExtensions\.formats\.title/u);
assert.match(localizationSource, /"settings\.externalExtensions\.formats\.title": "Supported local formats"/u);
assert.match(clientSettingsSource, /const fingerprint = extension\.contentHash/u);
assert.doesNotMatch(clientSettingsSource, /\+ New Draft/u);
assert.match(settingsPanelSource, /extensionPolicy\?\.externalExtensionsEnabled && <ExternalExtensionsSettings/u);
assert.match(settingsPanelSource, /settings\.externalExtensions\.warning/u);

assert.match(clientInjectorSource, /iframe\.setAttribute\("sandbox", "allow-scripts"\)/u);
assert.doesNotMatch(clientInjectorSource, /allow-same-origin/u);
assert.match(clientInjectorSource, /event\.origin !== "null"/u);
assert.doesNotMatch(clientInjectorSource, /document\.head|createElement\("script"\)|runtime\.js/u);
assert.match(clientHooksSource, /refetchInterval:\s*2_000/u);
assert.match(clientHooksSource, /refetchIntervalInBackground:\s*true/u);
assert.match(routeSource, /worker-src blob:/u);
assert.match(routeSource, /connect-src 'none'/u);
assert.match(routeSource, /new Worker\(workerUrl\)/u);
assert.match(routeSource, /sandbox became unresponsive/u);
assert.match(routeSource, /canExecutePersonalExtension/u);
assert.match(routeSource, /ENABLE_EXTERNAL_EXTENSIONS=true/u);

assert.match(schemaSource, /acknowledgeSandboxedCode:\s*z\.literal\(true\)/u);
assert.doesNotMatch(schemaSource, /acknowledgeFullTrust/u);
assert.match(runtimeSource, /spawnSandboxedPersonalExtension/u);
assert.doesNotMatch(runtimeSource, /pathToFileURL|safeFetch|await import\(/u);
assert.match(sandboxSource, /--permission/u);
assert.match(sandboxSource, /--unshare-all/u);
assert.match(sandboxSource, /macos-seatbelt/u);
assert.match(sandboxSource, /linux-bubblewrap/u);

assert.match(backupSource, /quarantineProfilePersonalExtensionRow/u);
assert.match(backupSource, /approvedHash: null/u);
assert.match(professorMariSource, /Never claim to approve, enable, or run an extension/u);
assert.doesNotMatch(professorMariSource, /personal_extension\.approve|personal_extension\.enable/u);

const manifestWithEnabled = createPersonalExtensionSchema.parse({
  name: "Manifest tries to self-enable",
  runtime: "client",
  js: "globalThis.__manifestShouldNotRun = true;",
  enabled: true,
});
assert.equal("enabled" in manifestWithEnabled, false);

const storageDir = mkdtempSync(join(tmpdir(), "marinara-personal-extension-security-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const previousExternalGate = process.env.ENABLE_EXTERNAL_EXTENSIONS;
const previousSandboxSecret = process.env.MARINARA_EXTENSION_SANDBOX_SECRET;
process.env.FILE_STORAGE_DIR = storageDir;
process.env.ENABLE_EXTERNAL_EXTENSIONS = "false";
process.env.MARINARA_EXTENSION_SANDBOX_SECRET = "must-not-leak";
const outsideSecretPath = join(storageDir, "outside-secret.txt");
writeFileSync(outsideSecretPath, "outside-secret", "utf8");
const fileDb = await createFileNativeDB();
const db = fileDb as unknown as DB;
try {
  const timestamp = new Date(0).toISOString();
  await db.insert(installedExtensions).values({
    id: "legacy-local-extension",
    name: "Legacy local extension",
    description: "Regression fixture",
    runtime: "client",
    css: null,
    js: "globalThis.__legacyShouldWaitForApproval = true;",
    serverJs: null,
    enabled: "true",
    installedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(appSettings).values({
    key: "extension-storage:legacy-local-extension",
    value: '{"kept":true}',
    updatedAt: timestamp,
  });

  const migration = await preparePersonalExtensionTrust(db);
  assert.deepEqual(migration, { legacyRecordsQuarantined: 1, changedRecordsDisabled: 0 });
  const migratedRows = await db.select().from(installedExtensions);
  assert.equal(migratedRows[0]!.enabled, "false");
  assert.equal(migratedRows[0]!.approvedHash, null);
  assert.equal(migratedRows[0]!.source, "legacy");

  const storage = createPersonalExtensionsStorage(db);
  const externalDraft = await storage.create(
    {
      name: "Dropped external extension",
      runtime: "client",
      js: "marinara.log.info('external');",
    },
    { source: "external" },
  );
  assert.ok(externalDraft);
  assert.equal(externalDraft.enabled, false);

  await createAppSettingsStorage(db).set("external-extensions-enabled", "true");
  let policy = await getPersonalExtensionPolicy(db);
  assert.equal(policy.externalExtensionsEnvEnabled, false);
  assert.equal(policy.externalExtensionsEnabled, false);

  const directlyApprovedExternal = await storage.approve(externalDraft.id, externalDraft.contentHash);
  assert.equal(directlyApprovedExternal?.enabled, true);
  const policyRuntime = new PersonalServerExtensionRuntime();
  await policyRuntime.start(db);
  assert.equal((await storage.getById(externalDraft.id))?.enabled, false);
  await policyRuntime.stop();

  process.env.ENABLE_EXTERNAL_EXTENSIONS = "true";
  await setExternalExtensionsEnabled(db, false);
  policy = await getPersonalExtensionPolicy(db);
  assert.equal(policy.externalExtensionsEnvEnabled, true);
  assert.equal(policy.externalExtensionsEnabled, false);
  policy = await setExternalExtensionsEnabled(db, true);
  assert.equal(policy.externalExtensionsEnabled, true);

  const mariDb = getMariDbService(db);
  const mariCreate = await mariDb.executeAction({
    action: "personal_extension.create",
    data: {
      name: "Professor Mari draft",
      runtime: "client",
      js: "marinara.log.info('draft');",
    },
    apply: true,
    sessionId: "personal-extension-regression",
  });
  assert.equal(mariCreate.ok, true, JSON.stringify(mariCreate));
  const mariDraft = await storage.getByName("Professor Mari draft");
  assert.ok(mariDraft);
  assert.equal(mariDraft.source, "professor_mari");
  assert.equal(mariDraft.enabled, false);
  assert.equal(mariDraft.approvedHash, null);

  const forbiddenMariApproval = await mariDb.executeAction({
    action: "personal_extension.approve",
    extensionId: mariDraft.id,
    apply: true,
    sessionId: "personal-extension-regression",
  });
  assert.equal(forbiddenMariApproval.ok, false);

  const rawApprovalAttempt = await mariDb.executeCli({
    argv: [
      "db",
      "patch",
      "installed_extensions",
      mariDraft.id,
      "--json",
      JSON.stringify({ enabled: "true", approvedHash: mariDraft.contentHash }),
      "--apply",
    ],
    command: "mari db patch installed_extensions <id> --json <approval> --apply",
    sessionId: "personal-extension-regression",
  });
  assert.equal(rawApprovalAttempt.ok, false);
  assert.match(JSON.stringify(rawApprovalAttempt.validation), /cannot mutate Personal Extensions through raw DB actions/u);

  const sandbox = getPersonalExtensionSandboxStatus();
  if (!sandbox.available) {
    assert.ok(sandbox.reason.length > 0);
    console.log(`Server extension sandbox runtime proof skipped: ${sandbox.reason}`);
  } else {
    const serverDraft = await storage.create(
      {
        name: "Sandbox capability proof",
        runtime: "server",
        serverJs: `
          const escapedProcess = globalThis.constructor.constructor("return process")();
          const fs = escapedProcess.getBuiltinModule("node:fs");
          const childProcess = escapedProcess.getBuiltinModule("node:child_process");
          const net = escapedProcess.getBuiltinModule("node:net");
          let outsideReadBlocked = false;
          let arbitraryWriteBlocked = false;
          let childProcessBlocked = false;
          let parentSignalBlocked = false;
          let networkBlocked = false;
          try { fs.readFileSync(${JSON.stringify(outsideSecretPath)}, "utf8"); } catch { outsideReadBlocked = true; }
          try { fs.writeFileSync(escapedProcess.env.HOME + "/extension-owned.txt", "unsafe"); } catch { arbitraryWriteBlocked = true; }
          try { childProcess.spawnSync("/bin/echo", ["unsafe"]); } catch { childProcessBlocked = true; }
          try { escapedProcess.kill(escapedProcess.ppid, 0); } catch { parentSignalBlocked = true; }
          await new Promise((resolve) => {
            let socket;
            try {
              socket = net.connect({ host: "127.0.0.1", port: 9 });
            } catch {
              networkBlocked = true;
              resolve();
              return;
            }
            socket.once("error", () => {
              networkBlocked = true;
              resolve();
            });
            marinara.setTimeout(() => {
              socket.destroy();
              resolve();
            }, 500);
          });
          await marinara.storage.patch({
            started: true,
            processType: typeof process,
            fetchType: typeof fetch,
            documentType: typeof document,
            inheritedSecret: escapedProcess.env.MARINARA_EXTENSION_SANDBOX_SECRET ?? null,
            outsideReadBlocked,
            arbitraryWriteBlocked,
            childProcessBlocked,
            parentSignalBlocked,
            networkBlocked,
          });
          marinara.onCleanup(async () => {
            await marinara.storage.patch({ stopped: true });
          });
        `,
      },
      { source: "professor_mari" },
    );
    assert.ok(serverDraft);
    const approvedServer = await storage.approve(serverDraft.id, serverDraft.contentHash);
    assert.ok(approvedServer?.enabled);
    const runtime = new PersonalServerExtensionRuntime();
    const extensionSettings = createPersonalExtensionSettingsStorage(createAppSettingsStorage(db));
    await runtime.start(db);
    assert.equal(runtime.withRuntimeStatus(approvedServer).serverStatus, "running");
    assert.deepEqual(await extensionSettings.get(serverDraft.id), {
      started: true,
      processType: "undefined",
      fetchType: "undefined",
      documentType: "undefined",
      inheritedSecret: null,
      outsideReadBlocked: true,
      arbitraryWriteBlocked: true,
      childProcessBlocked: true,
      parentSignalBlocked: true,
      networkBlocked: true,
    });
    await runtime.stop();
    assert.deepEqual(await extensionSettings.get(serverDraft.id), {
      started: true,
      stopped: true,
      processType: "undefined",
      fetchType: "undefined",
      documentType: "undefined",
      inheritedSecret: null,
      outsideReadBlocked: true,
      arbitraryWriteBlocked: true,
      childProcessBlocked: true,
      parentSignalBlocked: true,
      networkBlocked: true,
    });
    console.log(`Server extension sandbox runtime proof passed with ${sandbox.backend}.`);
  }

  await setExternalExtensionsEnabled(db, false);
  const approvedAgain = await storage.approve(externalDraft.id, externalDraft.contentHash);
  assert.equal(approvedAgain?.enabled, true);
  const closedGateRuntime = new PersonalServerExtensionRuntime();
  await closedGateRuntime.start(db);
  assert.equal((await storage.getById(externalDraft.id))?.enabled, false);
  await closedGateRuntime.stop();
} finally {
  await fileDb._fileStore.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  if (previousExternalGate === undefined) delete process.env.ENABLE_EXTERNAL_EXTENSIONS;
  else process.env.ENABLE_EXTERNAL_EXTENSIONS = previousExternalGate;
  if (previousSandboxSecret === undefined) delete process.env.MARINARA_EXTENSION_SANDBOX_SECRET;
  else process.env.MARINARA_EXTENSION_SANDBOX_SECRET = previousSandboxSecret;
  rmSync(storageDir, { recursive: true, force: true });
}

// Constrained browser UI capability — assert the security invariants of the
// generated worker/bootstrap source so a regression cannot silently widen the
// sandbox (e.g. reintroduce innerHTML or leak DOM/network to the extension).
{
  const { browserWorkerSource, sandboxDocument } = await import(
    "../../packages/server/src/routes/personal-extensions.routes.js"
  );
  const uiExtension = {
    id: "ui-demo",
    name: "UI Demo",
    contentHash: "sha256:demo",
    runtime: "client" as const,
    css: "",
    js: "const w = marinara.ui.showWindow({ title: 'Bunny', elements: [{ kind: 'pre', text: '(\\u2022_\\u2022)' }] });",
    serverJs: null,
    description: "",
    version: null,
    enabled: true,
    approvedHash: "sha256:demo",
    source: "professor_mari" as const,
    revisions: [],
    installedAt: "",
    createdAt: "",
    updatedAt: "",
  };
  const worker = browserWorkerSource(uiExtension);
  assert.match(worker, /ui:\s*Object\.freeze\(\{\s*showWindow/u, "Worker must expose marinara.ui.showWindow");
  assert.match(worker, /"ui-show"/u, "Worker must send a ui-show descriptor message");
  assert.match(worker, /"ui-event"/u, "Worker must receive button events via ui-event");
  assert.doesNotMatch(worker, /\bdocument\b/u, "Worker source must never touch the DOM");

  const doc = sandboxDocument(uiExtension, "test-nonce");
  assert.match(doc, /textContent/u, "Sandbox bootstrap must render window text via textContent");
  assert.doesNotMatch(doc, /innerHTML/u, "Sandbox bootstrap must never assign innerHTML");
  assert.match(doc, /ui-window-open/u, "Sandbox reveals the iframe only through the ui-window-open signal");
  assert.match(doc, /ui-resize/u, "Sandbox reports its content size so the host can fit the floating panel");
  assert.doesNotMatch(
    doc,
    /rgba\(0,\s*0,\s*0,\s*0\.45\)/u,
    "The extension window is a floating panel, not a full-screen backdrop takeover",
  );
  assert.ok(
    doc.includes("new Worker(") && doc.includes("marinara.ui.showWindow"),
    "Extension JS must run in the worker embedded by the bootstrap, not in the document",
  );
}

console.log("Personal Extension sandbox and policy regression passed.");
