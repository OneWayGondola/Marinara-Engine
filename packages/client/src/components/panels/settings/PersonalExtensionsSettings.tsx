import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Clock3,
  Code2,
  Download,
  FileArchive,
  FolderOpen,
  History,
  Loader2,
  Pencil,
  Power,
  PowerOff,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import type { PersonalExtension } from "@marinara-engine/shared";
import { ApiError, getPrivilegedActionErrorMessage } from "../../../lib/api-client";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import { cn } from "../../../lib/utils";
import {
  useApprovePersonalExtension,
  useCreatePersonalExtension,
  useDeletePersonalExtension,
  usePersonalExtensions,
  useRollbackPersonalExtension,
  useUpdatePersonalExtension,
} from "../../../hooks/use-personal-extensions";
import {
  collectFolderPackageEntries,
  readTextFilesFromFileList,
  type FolderPackageImportEntry,
} from "../../../lib/folder-package-transfer";
import { isZipFile, readTextFilesFromZip } from "../../../lib/read-zip-text";
import {
  comparePersonalExtensionVersions,
  createLoosePersonalExtensionEntries,
  normalizePersonalExtensionImportEntry,
  personalExtensionEntriesFromJson,
  personalExtensionEntryFromSourceFile,
  type PersonalExtensionImportDraft,
} from "../../../lib/personal-extension-import";
import { downloadZipFile } from "../../../lib/download-zip";
import {
  createPersonalExtensionPackageFilename,
  createPersonalExtensionPackageFiles,
} from "../../../lib/personal-extension-transfer";
import { SettingsIntro, SettingsSection } from "./SettingControls";

type EditorDraft = PersonalExtensionImportDraft;

const EMPTY_DRAFT: EditorDraft = {
  name: "",
  version: null,
  description: "",
  runtime: "client",
  css: "",
  js: "",
  serverJs: null,
};

function shortHash(hash: string) {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}

function sourceLabel(source: PersonalExtension["source"], t: TFunction) {
  if (source === "professor_mari") return "Professor Mari";
  if (source === "profile_import") return "Profile import";
  if (source === "legacy") return "Recovered legacy";
  return t("settings.externalExtensions.source");
}

function extensionDraft(extension: PersonalExtension): EditorDraft {
  return {
    name: extension.name,
    version: extension.version,
    description: extension.description,
    runtime: extension.runtime,
    css: extension.css,
    js: extension.js,
    serverJs: extension.serverJs,
  };
}

function triggerFilePicker(options: {
  accept?: string;
  multiple?: boolean;
  webkitdirectory?: boolean;
  onSelect: (files: FileList) => void;
}) {
  document.querySelectorAll(".marinara-personal-extension-picker").forEach((element) => element.remove());
  const input = document.createElement("input");
  input.type = "file";
  input.className = "marinara-personal-extension-picker";
  input.style.position = "fixed";
  input.style.inset = "0 auto auto 0";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  if (options.accept) input.accept = options.accept;
  if (options.multiple) input.multiple = true;
  if (options.webkitdirectory) input.setAttribute("webkitdirectory", "");
  input.addEventListener(
    "change",
    () => {
      const files = input.files;
      if (files?.length) options.onSelect(files);
      input.remove();
    },
    { once: true },
  );
  document.body.appendChild(input);
  input.click();
}

function validateDraft(draft: EditorDraft) {
  if (!draft.name.trim()) return "Name is required.";
  if (draft.runtime === "server" && !draft.serverJs?.trim()) return "Server JavaScript is required.";
  if (draft.runtime === "client" && !draft.css?.trim() && !draft.js?.trim()) {
    return "Add CSS or browser JavaScript.";
  }
  return null;
}

function riskMessage(extension: PersonalExtension, t: TFunction) {
  const fingerprint = extension.contentHash;
  if (extension.runtime === "server") {
    return t("settings.personalExtensions.approval.server", { name: extension.name, hash: fingerprint });
  }
  return t("settings.personalExtensions.approval.browser", { name: extension.name, hash: fingerprint });
}

function normalizeImportedName(fileName: string) {
  return fileName
    .replace(/\.personal-extension\.zip$/i, "")
    .replace(/\.server\.(js|mjs|cjs)$/i, "")
    .replace(/\.(json|css|js|mjs|cjs|zip)$/i, "");
}

type ExtensionSettingsMode = "personal" | "external";

export function PersonalExtensionsSettings({ showIntro = true }: { showIntro?: boolean }) {
  return <ExtensionSettings showIntro={showIntro} mode="personal" />;
}

export function ExternalExtensionsSettings({ showIntro = false }: { showIntro?: boolean }) {
  return <ExtensionSettings showIntro={showIntro} mode="external" />;
}

function ExtensionSettings({ showIntro, mode }: { showIntro: boolean; mode: ExtensionSettingsMode }) {
  const { t } = useTranslation();
  const { data: allExtensions = [], isLoading, error } = usePersonalExtensions();
  const extensions = useMemo(
    () =>
      allExtensions.filter((extension) =>
        mode === "personal" ? extension.source === "professor_mari" : extension.source !== "professor_mari",
      ),
    [allExtensions, mode],
  );
  const isExternal = mode === "external";
  const createExtension = useCreatePersonalExtension();
  const updateExtension = useUpdatePersonalExtension();
  const approveExtension = useApprovePersonalExtension();
  const rollbackExtension = useRollbackPersonalExtension();
  const deleteExtension = useDeletePersonalExtension();
  const [editorId, setEditorId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_DRAFT);
  const [importing, setImporting] = useState(false);

  const editingExtension = useMemo(
    () => (editorId ? extensions.find((extension) => extension.id === editorId) ?? null : null),
    [editorId, extensions],
  );
  const busy =
    createExtension.isPending ||
    updateExtension.isPending ||
    approveExtension.isPending ||
    rollbackExtension.isPending ||
    deleteExtension.isPending ||
    importing;

  const openExisting = useCallback((extension: PersonalExtension) => {
    setDraft(extensionDraft(extension));
    setEditorId(extension.id);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorId(null);
    setDraft({ ...EMPTY_DRAFT });
  }, []);

  const saveDraft = useCallback(async () => {
    if (!editingExtension) {
      toast.error("Personal Extension not found.");
      return;
    }
    const validation = validateDraft(draft);
    if (validation) {
      toast.error(validation);
      return;
    }
    const payload = {
      name: draft.name.trim(),
      version: draft.version?.trim() || null,
      description: draft.description,
      runtime: draft.runtime,
      css: draft.runtime === "client" ? draft.css || null : null,
      js: draft.runtime === "client" ? draft.js || null : null,
      serverJs: draft.runtime === "server" ? draft.serverJs || null : null,
    } as const;
    try {
      const updated = await updateExtension.mutateAsync({ id: editingExtension.id, ...payload });
      toast.success(
        updated.approvedHash === updated.contentHash
          ? `"${updated.name}" saved`
          : `"${updated.name}" saved as a disabled draft. Review and run it when ready.`,
      );
      setDraft(extensionDraft(updated));
    } catch (saveError) {
      toast.error(getPrivilegedActionErrorMessage(saveError, "Failed to save Personal Extension."));
    }
  }, [draft, editingExtension, updateExtension]);

  const runExtension = useCallback(
    async (extension: PersonalExtension) => {
      const confirmed = await showConfirmDialog({
        title: t(
          extension.runtime === "server"
            ? "settings.personalExtensions.approval.titleServer"
            : "settings.personalExtensions.approval.titleBrowser",
        ),
        message: riskMessage(extension, t),
        confirmLabel: t("settings.personalExtensions.approval.confirmLabel"),
        cancelLabel: t("settings.personalExtensions.approval.cancelLabel"),
      });
      if (!confirmed) return;
      try {
        await approveExtension.mutateAsync({ id: extension.id, contentHash: extension.contentHash });
        toast.success(`"${extension.name}" is enabled for hash ${shortHash(extension.contentHash)}`);
      } catch (runError) {
        toast.error(getPrivilegedActionErrorMessage(runError, "Failed to enable Personal Extension."));
      }
    },
    [approveExtension, t],
  );

  const disableExtension = useCallback(
    async (extension: PersonalExtension) => {
      try {
        await updateExtension.mutateAsync({ id: extension.id, enabled: false });
        toast.success(`"${extension.name}" disabled`);
      } catch (disableError) {
        toast.error(getPrivilegedActionErrorMessage(disableError, "Failed to disable Personal Extension."));
      }
    },
    [updateExtension],
  );

  const removeExtension = useCallback(
    async (extension: PersonalExtension) => {
      const confirmed = await showConfirmDialog({
        title: "Delete Personal Extension?",
        message: `Delete "${extension.name}" and its private extension storage? This cannot be undone.`,
        confirmLabel: "Delete",
        tone: "destructive",
      });
      if (!confirmed) return;
      try {
        await deleteExtension.mutateAsync(extension.id);
        if (editorId === extension.id) closeEditor();
        toast.success(`"${extension.name}" deleted`);
      } catch (deleteError) {
        toast.error(getPrivilegedActionErrorMessage(deleteError, "Failed to delete Personal Extension."));
      }
    },
    [closeEditor, deleteExtension, editorId],
  );

  const restoreRevision = useCallback(
    async (extension: PersonalExtension, contentHash: string) => {
      const confirmed = await showConfirmDialog({
        title: "Restore This Revision?",
        message: `Restore hash ${shortHash(contentHash)} as a disabled draft? You will review and approve it again before it can run.`,
        confirmLabel: "Restore Draft",
      });
      if (!confirmed) return;
      try {
        const restored = await rollbackExtension.mutateAsync({ id: extension.id, contentHash });
        setDraft(extensionDraft(restored));
        toast.success(`Restored "${restored.name}" as a disabled draft`);
      } catch (rollbackError) {
        toast.error(getPrivilegedActionErrorMessage(rollbackError, "Failed to restore revision."));
      }
    },
    [rollbackExtension],
  );

  const installDraft = useCallback(
    async (imported: PersonalExtensionImportDraft, candidates: PersonalExtension[]) => {
      const existing = candidates.find(
        (extension) => extension.name.trim().toLowerCase() === imported.name.trim().toLowerCase(),
      );
      if (!existing) return createExtension.mutateAsync(imported);
      if (comparePersonalExtensionVersions(imported.version, existing.version) === -1) {
        const allowDowngrade = await showConfirmDialog({
          title: "Import Older Revision?",
          message: `The local file contains ${imported.version}, but "${existing.name}" is ${existing.version}. Save the local file as a new disabled revision anyway?`,
          confirmLabel: "Import Older Revision",
        });
        if (!allowDowngrade) return existing;
      }
      const confirmed = await showConfirmDialog({
        title: "Update Personal Extension?",
        message: `Replace the saved code for "${existing.name}" with this local file? The extension will be disabled and require approval of its new hash.`,
        confirmLabel: "Save Disabled Update",
      });
      if (!confirmed) return existing;
      return updateExtension.mutateAsync({ id: existing.id, ...imported });
    },
    [createExtension, updateExtension],
  );

  const importEntries = useCallback(
    async (entries: FolderPackageImportEntry[], fallbackName: string) => {
      let installed = 0;
      let skipped = 0;
      let working = [...extensions];
      for (const entry of entries) {
        const imported = normalizePersonalExtensionImportEntry(entry, fallbackName);
        if (!imported) {
          skipped += 1;
          continue;
        }
        const saved = await installDraft(imported, working);
        if (!working.some((candidate) => candidate.id === saved.id && candidate.contentHash === saved.contentHash)) {
          installed += 1;
        }
        working = [saved, ...working.filter((candidate) => candidate.id !== saved.id)];
      }
      if (installed === 0 && skipped === 0) throw new Error("No Personal Extensions were found.");
      if (installed > 0) {
        toast.success(`${installed} Personal Extension${installed === 1 ? "" : "s"} saved as disabled drafts`);
      }
      if (skipped > 0) {
        toast.warning(`${skipped} invalid extension entr${skipped === 1 ? "y was" : "ies were"} skipped`);
      }
    },
    [extensions, installDraft],
  );

  const importFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const fallbackName = normalizeImportedName(file.name) || "Personal Extension";
        if (isZipFile(file)) {
          const files = await readTextFilesFromZip(file);
          const entries = collectFolderPackageEntries(files, {
            rootFilenames: ["marinara-extensions.json", "marinara-extension.json", "marinara-personal-extensions.json"],
            collectionKeys: ["extensions", "personalExtensions"],
          });
          await importEntries(
            entries.length ? entries : createLoosePersonalExtensionEntries(files, fallbackName),
            fallbackName,
          );
        } else if (file.name.toLowerCase().endsWith(".json")) {
          await importEntries(personalExtensionEntriesFromJson(JSON.parse(await file.text()), file.name), fallbackName);
        } else {
          const entry = personalExtensionEntryFromSourceFile(file.name, await file.text());
          if (!entry) throw new Error("Unsupported file type.");
          await importEntries([entry], fallbackName);
        }
      } catch (importError) {
        toast.error(getPrivilegedActionErrorMessage(importError, "Failed to import Personal Extension."));
      } finally {
        setImporting(false);
      }
    },
    [importEntries],
  );

  const importFolder = useCallback(
    async (files: FileList) => {
      setImporting(true);
      try {
        const textFiles = await readTextFilesFromFileList(files);
        const firstPath = textFiles[0]?.path ?? "Personal Extension";
        const fallbackName = firstPath.includes("/") ? firstPath.slice(0, firstPath.indexOf("/")) : "Personal Extension";
        const entries = collectFolderPackageEntries(textFiles, {
          rootFilenames: ["marinara-extensions.json", "marinara-extension.json", "marinara-personal-extensions.json"],
          collectionKeys: ["extensions", "personalExtensions"],
        });
        await importEntries(
          entries.length ? entries : createLoosePersonalExtensionEntries(textFiles, fallbackName),
          fallbackName,
        );
      } catch (importError) {
        toast.error(getPrivilegedActionErrorMessage(importError, "Failed to import Personal Extension folder."));
      } finally {
        setImporting(false);
      }
    },
    [importEntries],
  );

  if (editorId) {
    const current = editingExtension
      ? (extensions.find((extension) => extension.id === editingExtension.id) ?? editingExtension)
      : null;
    const approvalChanged = Boolean(current && current.approvedHash !== current.contentHash);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={closeEditor}
            className="flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            <ChevronLeft size="0.875rem" />
            {isExternal ? t("settings.externalExtensions.title") : "Personal Extensions"}
          </button>
          <div className="flex flex-wrap items-center gap-1.5">
            {current && (
              <button
                type="button"
                onClick={() => void (current.enabled ? disableExtension(current) : runExtension(current))}
                disabled={busy}
                className={cn(
                  "flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  current.enabled
                    ? "bg-[var(--secondary)] text-[var(--foreground)] hover:bg-[var(--accent)]"
                    : "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90",
                )}
              >
                {current.enabled ? <PowerOff size="0.75rem" /> : <Power size="0.75rem" />}
                {current.enabled ? "Disable" : "Review and Run"}
              </button>
            )}
            {isExternal && (
              <button
                type="button"
                onClick={() => void saveDraft()}
                disabled={busy}
                className="flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 size="0.75rem" className="animate-spin" /> : <Save size="0.75rem" />}
                Save Draft
              </button>
            )}
          </div>
        </div>

        {current && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
              current.enabled
                ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)]"
                : approvalChanged
                  ? "border-[var(--primary)]/25 bg-[var(--primary)]/[0.06] text-[var(--foreground)]"
                  : "border-[var(--border)] bg-[var(--secondary)]/50 text-[var(--muted-foreground)]",
            )}
          >
            {current.enabled ? (
              <Check size="0.875rem" className="mt-0.5 shrink-0" />
            ) : approvalChanged ? (
              <ShieldAlert size="0.875rem" className="mt-0.5 shrink-0" />
            ) : (
              <PowerOff size="0.875rem" className="mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="font-semibold">
                {current.enabled ? "Running approved code" : approvalChanged ? "Disabled pending approval" : "Disabled"}
              </div>
              <div className="mt-0.5 break-all text-[0.625rem] opacity-80">
                Hash {current.contentHash}, source {sourceLabel(current.source, t)}
              </div>
              {current.serverError && <div className="mt-1 text-[var(--destructive)]">{current.serverError}</div>}
            </div>
          </div>
        )}

        <div className="grid gap-2">
          <label className="flex flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            Name
            <input
              value={draft.name}
              readOnly={!isExternal}
              onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
              className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            Version
            <input
              value={draft.version ?? ""}
              readOnly={!isExternal}
              onChange={(event) => setDraft((value) => ({ ...value, version: event.target.value || null }))}
              placeholder="1.0.0"
              className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            Runtime
            <select
              value={draft.runtime}
              disabled={!isExternal}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  runtime: event.target.value === "server" ? "server" : "client",
                }))
              }
              className="min-h-10 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
            >
              <option value="client">Browser</option>
              <option value="server">Server</option>
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
          Description
          <textarea
            value={draft.description}
            readOnly={!isExternal}
            onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
            rows={2}
            className="resize-y rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
          />
        </label>

        <div className="flex items-start gap-2 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/[0.08] px-3 py-2.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
          <AlertTriangle size="0.875rem" className="mt-0.5 shrink-0 text-[var(--primary)]" />
          {draft.runtime === "server"
            ? t("settings.personalExtensions.sandbox.server")
            : t("settings.personalExtensions.sandbox.browser")}
        </div>

        {draft.runtime === "client" ? (
          <div className="grid gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              CSS (sanitized before use)
              <textarea
                value={draft.css ?? ""}
                readOnly={!isExternal}
                onChange={(event) => setDraft((value) => ({ ...value, css: event.target.value }))}
                spellCheck={false}
                placeholder="/* Optional extension CSS */"
                className="min-h-72 resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              Browser JavaScript
              <textarea
                value={draft.js ?? ""}
                readOnly={!isExternal}
                onChange={(event) => setDraft((value) => ({ ...value, js: event.target.value }))}
                spellCheck={false}
                placeholder="// Optional browser JavaScript"
                className="min-h-72 resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
              />
            </label>
          </div>
        ) : (
          <label className="flex min-w-0 flex-col gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            Server JavaScript
            <textarea
              value={draft.serverJs ?? ""}
              readOnly={!isExternal}
              onChange={(event) => setDraft((value) => ({ ...value, serverJs: event.target.value }))}
              spellCheck={false}
              placeholder="// Trusted server JavaScript"
              className="min-h-96 resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]/60"
            />
          </label>
        )}

        {current && current.revisions.length > 0 && (
          <details className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/35">
            <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 text-xs font-semibold">
              <History size="0.875rem" />
              Revision History ({current.revisions.length})
            </summary>
            <div className="flex flex-col gap-1.5 border-t border-[var(--border)] p-2">
              {current.revisions.map((revision) => (
                <div
                  key={`${revision.contentHash}-${revision.savedAt}`}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--background)]/60 px-2.5 py-2 text-[0.625rem]"
                >
                  <Clock3 size="0.75rem" className="text-[var(--muted-foreground)]" />
                  <span className="font-mono">{shortHash(revision.contentHash)}</span>
                  <span className="text-[var(--muted-foreground)]">
                    {revision.runtime === "server" ? "Server" : "Browser"}
                    {revision.version ? `, v${revision.version}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => void restoreRevision(current, revision.contentHash)}
                    disabled={busy}
                    className="ml-auto flex min-h-8 items-center gap-1 rounded-md px-2 text-[var(--primary)] transition-colors hover:bg-[var(--primary)]/10 disabled:opacity-50"
                  >
                    <RotateCcw size="0.6875rem" />
                    Restore Draft
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {showIntro && (
        <SettingsIntro>
          {isExternal
            ? t("settings.externalExtensions.intro")
            : t("settings.personalExtensions.empty.description")}
        </SettingsIntro>
      )}
      <SettingsSection
        title={isExternal ? t("settings.externalExtensions.title") : "Personal Extensions"}
        description={
          isExternal
            ? t("settings.externalExtensions.description")
            : t("settings.personalExtensions.empty.description")
        }
        icon={isExternal ? <ShieldAlert size="0.875rem" /> : <Code2 size="0.875rem" />}
        anchorId={isExternal ? "settings-section-external-extensions" : "settings-section-personal-extensions"}
      >
        <div className="flex flex-col gap-3">
          {isExternal && (
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() =>
                  triggerFilePicker({
                    accept:
                      ".zip,.json,.css,.js,.mjs,.cjs,.server.js,.server.mjs,.server.cjs,application/zip,application/json",
                    onSelect: (files) => {
                      const file = files[0];
                      if (file) void importFile(file);
                    },
                  })
                }
                disabled={busy}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/55 px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
              >
                {importing ? <Loader2 size="0.875rem" className="animate-spin" /> : <FileArchive size="0.875rem" />}
                {t("settings.externalExtensions.import.file")}
              </button>
              <button
                type="button"
                onClick={() =>
                  triggerFilePicker({
                    multiple: true,
                    webkitdirectory: true,
                    onSelect: (files) => void importFolder(files),
                  })
                }
                disabled={busy}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/55 px-3 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
              >
                <FolderOpen size="0.875rem" />
                {t("settings.externalExtensions.import.folder")}
              </button>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)]/45 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            <ShieldAlert size="0.875rem" className="mt-0.5 shrink-0 text-[var(--primary)]" />
            {isExternal
              ? t("settings.externalExtensions.safety")
              : t("settings.personalExtensions.safety")}
          </div>

          {error && (
            <div className="rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/8 px-3 py-2.5 text-xs text-[var(--destructive)]">
              {error instanceof ApiError && error.status === 403
                ? "Personal Extension management needs localhost or Admin Access on this device."
                : "Personal Extensions could not be loaded."}
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col gap-2" aria-label="Loading Personal Extensions">
              {[0, 1].map((index) => (
                <div key={index} className="h-16 animate-pulse rounded-lg bg-[var(--secondary)]/60" />
              ))}
            </div>
          ) : extensions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-4 py-8 text-center">
              <Code2 size="1.25rem" className="text-[var(--muted-foreground)]" />
              <div className="text-xs font-semibold">
                {isExternal ? t("settings.externalExtensions.empty.title") : "No Personal Extensions yet"}
              </div>
              <p className="max-w-md text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                {isExternal
                  ? t("settings.externalExtensions.empty.description")
                  : t("settings.personalExtensions.empty.description")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {extensions.map((extension) => {
                const approved = extension.approvedHash === extension.contentHash;
                const status = extension.enabled
                  ? extension.runtime === "server"
                    ? extension.serverStatus === "error"
                      ? "Error"
                      : "Running"
                    : "Enabled"
                  : approved
                    ? "Disabled"
                    : "Needs approval";
                return (
                  <div
                    key={extension.id}
                    className={cn(
                      "group relative rounded-lg border px-3 py-2.5 pr-32 transition-colors max-md:pr-28",
                      extension.enabled
                        ? "border-emerald-500/25 bg-emerald-500/6"
                        : "border-[var(--border)] bg-[var(--secondary)]/45 hover:bg-[var(--secondary)]/70",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => openExisting(extension)}
                      className="flex w-full min-w-0 items-start gap-2 text-left"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
                          extension.enabled
                            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                            : "border-[var(--border)] bg-[var(--background)]/60 text-[var(--muted-foreground)]",
                        )}
                      >
                        {extension.enabled ? <Power size="0.75rem" /> : <Code2 size="0.75rem" />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                          <span className="truncate text-xs font-semibold text-[var(--foreground)]">{extension.name}</span>
                          {extension.version && (
                            <span className="text-[0.5625rem] text-[var(--muted-foreground)]">v{extension.version}</span>
                          )}
                          <span className="rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold ring-1 ring-[var(--border)]">
                            {extension.runtime === "server" ? "Server" : "Browser"}
                          </span>
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[0.5625rem] font-semibold ring-1",
                              extension.enabled
                                ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
                                : approved
                                  ? "bg-[var(--background)]/60 text-[var(--muted-foreground)] ring-[var(--border)]"
                                  : "bg-amber-500/10 text-amber-300 ring-amber-500/20",
                            )}
                          >
                            {status}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-[0.625rem] text-[var(--muted-foreground)]">
                          {extension.description || `${sourceLabel(extension.source, t)} draft`}
                        </span>
                        <span className="mt-0.5 block font-mono text-[0.5625rem] text-[var(--muted-foreground)]">
                          {shortHash(extension.contentHash)}
                        </span>
                      </span>
                    </button>
                    <div className="absolute right-2 top-1/2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100">
                      <button
                        type="button"
                        onClick={() => openExisting(extension)}
                        className="rounded-md p-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] active:scale-90"
                        title="Review and edit"
                      >
                        <Pencil size="0.75rem" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void (extension.enabled ? disableExtension(extension) : runExtension(extension))}
                        disabled={busy}
                        className="rounded-md p-2 text-[var(--primary)] transition-colors hover:bg-[var(--primary)]/10 active:scale-90 disabled:opacity-50"
                        title={extension.enabled ? "Disable" : "Review and run"}
                      >
                        {extension.enabled ? <PowerOff size="0.75rem" /> : <Power size="0.75rem" />}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadZipFile(
                            createPersonalExtensionPackageFiles(extension),
                            createPersonalExtensionPackageFilename(extension.name),
                          )
                        }
                        className="rounded-md p-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] active:scale-90"
                        title="Export local package"
                      >
                        <Upload size="0.75rem" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeExtension(extension)}
                        disabled={busy}
                        className="rounded-md p-2 text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10 active:scale-90 disabled:opacity-50"
                        title="Delete"
                      >
                        <Trash2 size="0.75rem" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {isExternal && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/25">
              <div className="flex min-h-10 items-center gap-2 px-3 text-[0.6875rem] font-semibold">
                <Download size="0.75rem" />
                {t("settings.externalExtensions.formats.title")}
              </div>
              <div className="border-t border-[var(--border)] px-3 py-2.5 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
                {t("settings.externalExtensions.formats.description")}
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
