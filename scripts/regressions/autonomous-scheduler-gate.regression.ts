// #4705: the server autonomous scheduler skips its 60s full sweep when the
// chats table hasn't been written since a conclusive none-eligible sweep. The
// gate rides the file store's per-table write-generation counter — these
// regressions pin the counter semantics the gate depends on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { appSettings, chats } from "../../packages/server/src/db/schema/index.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-write-gen-"));
process.env.FILE_STORAGE_DIR = storageDir;

// Closed from the finally path even when an assertion fails mid-run: an
// unclosed store keeps its beforeExit flush handler armed, which could
// recreate the temp dir after rmSync removes it.
let closeStore: (() => Promise<void>) | undefined;

try {
  const db = await createFileNativeDB();
  closeStore = () => db._fileStore.close();

  // Never-written table reads generation 0.
  assert.equal(db._fileStore.getTableWriteGeneration("chats"), 0, "fresh table starts at generation 0");

  // Every write bumps the counter monotonically.
  await db.insert(chats).values({ id: "gen-chat-1", name: "Gen", mode: "conversation" });
  const afterInsert = db._fileStore.getTableWriteGeneration("chats");
  assert.ok(afterInsert > 0, "insert bumps the generation");

  await db.update(chats).set({ name: "Gen 2" }).where(eq(chats.id, "gen-chat-1"));
  const afterUpdate = db._fileStore.getTableWriteGeneration("chats");
  assert.ok(afterUpdate > afterInsert, "update bumps the generation further");

  // Writes to other tables leave this table's generation untouched — the
  // scheduler's gate must not be re-armed by unrelated storage traffic.
  await db.insert(appSettings).values({ key: "gen-probe", value: "x", updatedAt: "2026-08-07" });
  assert.equal(
    db._fileStore.getTableWriteGeneration("chats"),
    afterUpdate,
    "unrelated table writes do not bump the chats generation",
  );

  // A rolled-back transaction KEEPS the in-transaction bump AND adds a
  // rollback bump. The second half is the load-bearing part: reads are not
  // transaction-isolated, so a poll landing DURING the transaction can store
  // a generation derived from uncommitted rows — the restore must advance the
  // generation past that sample or the stale conclusion would never be
  // re-examined (the dormant-scheduler dirty-read found in review).
  const beforeRollback = db._fileStore.getTableWriteGeneration("chats");
  let generationSampledDuringTx = -1;
  await db
    .transaction(async (tx) => {
      await tx.update(chats).set({ name: "Rolled Back" }).where(eq(chats.id, "gen-chat-1"));
      // What a concurrently-polling reader would observe mid-transaction:
      generationSampledDuringTx = db._fileStore.getTableWriteGeneration("chats");
      throw new Error("force rollback");
    })
    .catch(() => {});
  const rolledBack = await db.select().from(chats).where(eq(chats.id, "gen-chat-1"));
  assert.equal(rolledBack[0]?.name, "Gen 2", "row content rolled back");
  assert.ok(generationSampledDuringTx > beforeRollback, "in-transaction write bumped the generation");
  assert.ok(
    db._fileStore.getTableWriteGeneration("chats") > generationSampledDuringTx,
    "rollback bumps the generation PAST any mid-transaction sample, so conclusions derived from uncommitted rows are re-examined",
  );

  // The sweep gate's state machine (pure, pinned against refactors): only a
  // conclusive none-eligible sweep may arm the skip, and the skip requires a
  // real, unchanged generation on both sides.
  const { concludeAutonomousSweep, shouldSkipAutonomousSweep } =
    await import("../../packages/server/src/services/conversation/server-autonomous-scheduler.service.js");
  assert.equal(concludeAutonomousSweep({ inconclusive: false, sawEligible: false, generation: 7 }), 7);
  assert.equal(
    concludeAutonomousSweep({ inconclusive: true, sawEligible: false, generation: 7 }),
    null,
    "cap-break/stopped sweeps prove nothing",
  );
  assert.equal(
    concludeAutonomousSweep({ inconclusive: false, sawEligible: true, generation: 7 }),
    null,
    "eligible chats keep sweeping",
  );
  assert.equal(
    concludeAutonomousSweep({ inconclusive: false, sawEligible: false, generation: null }),
    null,
    "no counter -> never arm",
  );
  assert.equal(shouldSkipAutonomousSweep(7, 7), true);
  assert.equal(shouldSkipAutonomousSweep(7, 8), false, "any write re-arms the sweep");
  assert.equal(shouldSkipAutonomousSweep(null, 7), false, "unarmed gate always sweeps");
  assert.equal(shouldSkipAutonomousSweep(7, null), false, "counter unavailable -> degrade to sweeping");

  console.info("Autonomous scheduler gate regressions passed.");
} finally {
  try {
    await closeStore?.();
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
}
