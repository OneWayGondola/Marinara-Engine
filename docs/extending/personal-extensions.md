# Personal Extensions

Personal Extensions are private code drafts created for you by Professor Mari. Open **Settings** > **Addons** > **Personal Extensions**.

The default message is:

> Ask Professor Mari to create an extension for you. Nothing runs until you enable it and approve the exact code hash.

There is no New Draft action and there are no import controls in this section. Ask Professor Mari to create or revise a draft. She can save code, but she cannot approve or enable it.

## Review and enable

Every draft starts disabled. Marinara fingerprints the exact executable code with SHA-256. Open the draft, inspect the code, compare the displayed hash, then choose **Review and Run** only if you accept that exact version. Any executable edit or restored revision disables the extension and requires a fresh approval.

Sandboxing reduces authority; it does not make arbitrary code trustworthy. A malicious extension can still waste CPU until the watchdog stops it, flood its own storage within enforced limits, or behave deceptively through logs. Always review code before enabling it.

## Runtime isolation

A Browser Extension runs in a dedicated Worker inside an opaque-origin sandboxed iframe. It cannot access Marinara's page, DOM, cookies, browser storage, origin APIs, or network. Its capabilities are private extension storage, logging, managed timers, cleanup registration, and a constrained window UI. The extension never touches Marinara's DOM or writes HTML: it describes a window as a small set of elements (headings, text, preformatted blocks, buttons, and inputs), and the trusted sandbox renders them as text. Buttons report clicks — with the current input values — back to the extension, so it can show output, drive small tools, or add controls. This is enough for a closable info window, an extra button that does something, or a simple input-and-result tool.

The window appears as a floating panel docked to the corner of the app, styled with the current accent color; the rest of Marinara stays visible and usable. It is not a full-screen takeover. Closing it (the panel's ✕) returns the app to normal.

These UI capabilities and rules are identical for every Browser Extension regardless of source. An imported third-party (External) Extension gets the same window API and the same accent styling once it clears the same gates — the `.env` and Danger Zone opt-ins plus exact-hash approval. A third-party extension can add or change UI only through this same sandboxed window; it still cannot reach Marinara's own DOM.

A Server Extension runs in a separate permission-restricted Node process inside macOS Seatbelt or Linux Bubblewrap. It cannot access Marinara files, user files, inherited server secrets, the network, child processes, workers, or native addons. If Marinara cannot establish a supported OS sandbox, Server Extensions remain disabled.

### Platform support

Browser Extensions are sandboxed by the browser itself, so they work everywhere. Server Extensions need a supported OS sandbox; where none exists, they stay disabled and cannot be enabled — Marinara never falls back to running them unsandboxed.

| Platform | Browser Extensions | Server Extensions |
| --- | --- | --- |
| macOS | ✅ Sandboxed | ✅ Sandboxed (Seatbelt) |
| Linux (with Bubblewrap) | ✅ Sandboxed | ✅ Sandboxed (Bubblewrap) |
| Linux (without `bwrap`) | ✅ Sandboxed | ⛔ Disabled — install `bwrap` |
| Windows | ✅ Sandboxed | ⛔ Disabled — use a Browser Extension |
| Android | ✅ Sandboxed | ⛔ Disabled — use a Browser Extension |

On Windows and Android there is no supported OS process sandbox, so Server Extensions are unavailable by design. Use a Browser Extension instead, or run the Marinara server on macOS or Linux (with `bwrap`) if you need a Server Extension.

## External Extensions

Third-party imports are locked and hidden by default. Two steps are required:

1. On the Marinara host, set `ENABLE_EXTERNAL_EXTENSIONS=true` in `.env`.
2. Open **Settings** > **Advanced** > **Danger Zone**, scroll below the data-deletion controls, read the warning, and enable **Allow third-party extension imports**.

Only then does **Settings** > **Addons** show **External Extensions** with file and folder import controls. Supported formats are always expanded:

- `.personal-extension.zip` and compatible `.zip` packages;
- `.json` manifests;
- `.css`;
- `.js`, `.mjs`, and `.cjs`;
- `.server.js`, `.server.mjs`, and `.server.cjs`.

Imports never carry approval and cannot enable themselves. Legacy, profile-imported, manually stored, and unknown-source records are also treated as external. They stay hidden, cannot be approved, and are excluded from both runtimes until both gates are open.

Turning either gate off stops active external server processes, removes browser workers, and disables stored external records. Reopening the gates does not automatically run them again.

Third-party extensions may contain malicious or dangerous code. Always inspect every line before downloading, importing, or enabling it. You proceed entirely at your own responsibility.

## Export, revisions, and recovery

Use an extension's export action to download a portable package. Exported and restored packages remain disabled. Restoring a revision also returns it to a disabled draft.

If an extension misbehaves, choose **Disable**. If the interface is unavailable, stop Marinara and set the relevant `installed_extensions` record's `enabled` value to `"false"`. Never set `approvedHash` by hand.

## Related guides

- [Professor Mari](../home/professor-mari.md)
- [Server Configuration](../CONFIGURATION.md)
- [Backup and Restore](../data/backup-and-restore.md)
- [Remote Access](../REMOTE_ACCESS.md)
