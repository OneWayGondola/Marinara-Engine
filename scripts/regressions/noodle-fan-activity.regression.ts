import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NOODLE_SETTINGS, type NoodleAccount } from "../../packages/shared/src/index.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  noodleInteractions,
  noodlePosts,
  noodlerFanActivityState,
} from "../../packages/server/src/db/schema/noodle.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { createNoodleStorage } from "../../packages/server/src/services/storage/noodle.storage.js";
import {
  parseGeneratedFanActivityResponse,
  resolveNoodlerFanActivityPolicy,
  selectNoodlerFanActivities,
  type NoodlerFanCreatorCandidate,
} from "../../packages/server/src/services/noodle/noodle-noodler-fan-activity.service.js";
import { syntheticNoodlerFanIdentityProvider } from "../../packages/server/src/services/noodle/noodle-fan-identity-provider.js";
import { runNoodlerFanActivity } from "../../packages/server/src/services/noodle/noodle-fan-activity.operation.js";

const settings = { ...DEFAULT_NOODLE_SETTINGS, fanActivityEnabled: true };
const creator = {
  id: "creator-1",
  settings: { scheduler: {}, privacy: {}, profile: {}, social: {}, wallet: { coins: 0 } },
} as NoodleAccount;
assert.equal(resolveNoodlerFanActivityPolicy(settings, creator).enabled, true);
creator.settings.scheduler.fanActivity = { enabled: false, archetypeWeights: { ordinary: 7 } };
const override = resolveNoodlerFanActivityPolicy(settings, creator);
assert.equal(override.enabled, false);
assert.equal(override.archetypeWeights.ordinary, 7);
assert.equal(override.archetypeWeights.eccentric, settings.fanArchetypeWeights.eccentric);

const identities = syntheticNoodlerFanIdentityProvider.resolve(settings.fanArchetypeWeights);
const normalizedResponse = parseGeneratedFanActivityResponse({
  activities: [
    {
      actorHandle: identities[0]!.snapshot.handle,
      creatorId: "creator-1",
      postId: "public-1",
      type: "like",
      content: null,
    },
    { actorHandle: identities[1]!.snapshot.handle, type: "reply", content: "Missing IDs" },
  ],
});
assert.equal(normalizedResponse.rejected, 1);
assert.deepEqual(normalizedResponse.value.activities[0], {
  actorHandle: identities[0]!.snapshot.handle,
  creatorAccountId: "creator-1",
  targetPostId: "public-1",
  type: "like",
  content: null,
});
const candidate: NoodlerFanCreatorCandidate = {
  creator: { ...creator, id: "creator-1" },
  policy: { enabled: true, archetypeWeights: settings.fanArchetypeWeights },
  identities,
  posts: [{ id: "public-1", creatorAccountId: "creator-1", title: null, content: "Hello", access: "public" }],
};
const selected = selectNoodlerFanActivities({
  activities: [
    {
      actorHandle: identities[0]!.snapshot.handle,
      creatorAccountId: "creator-1",
      targetPostId: "public-1",
      type: "like",
      content: null,
    },
    {
      actorHandle: identities[0]!.snapshot.handle,
      creatorAccountId: "wrong",
      targetPostId: "public-1",
      type: "reply",
      content: "Wrong owner",
    },
    {
      actorHandle: identities[0]!.snapshot.handle,
      creatorAccountId: "creator-1",
      targetPostId: "public-1",
      type: "reply",
      content: "One",
    },
    {
      actorHandle: identities[0]!.snapshot.handle,
      creatorAccountId: "creator-1",
      targetPostId: "public-1",
      type: "repost",
      content: null,
    },
    {
      actorHandle: identities[1]!.snapshot.handle,
      creatorAccountId: "creator-1",
      targetPostId: "public-1",
      type: "reply",
      content: "Two",
    },
    {
      actorHandle: identities[2]!.snapshot.handle,
      creatorAccountId: "creator-1",
      targetPostId: "public-1",
      type: "reply",
      content: "Over creator limit",
    },
  ],
  creators: [candidate],
  existingInteractions: [],
  quotas: { like: 1, reply: 4, repost: 1 },
});
assert.equal(selected.length, 4);
assert.ok(selected.every((activity) => activity.creatorId === "creator-1"));

const storageDir = mkdtempSync(join(tmpdir(), "marinara-noodler-fans-"));
process.env.FILE_STORAGE_DIR = storageDir;
try {
  const db = (await createFileNativeDB()) as unknown as DB;
  const noodle = createNoodleStorage(db);
  const publicAccount = await noodle.upsertAccountFromProfile({
    kind: "persona",
    entityId: "source-1",
    displayName: "Source",
  });
  const storedCreator = await noodle.createNoodlerAccount(publicAccount.id, {
    handle: "creator",
    displayName: "Creator",
    bio: "Bio",
    disclosureMode: "secret",
    stagePersonality: "Voice",
  });
  assert.ok(storedCreator);
  const post = await noodle.createNoodlerPost({
    authorAccountId: storedCreator!.id,
    title: null,
    content: "Public post",
    access: "public",
    source: "generated",
    metadata: {},
  });
  assert.ok(post);
  const identity = identities[0]!;
  await noodle.updateSettings({ enableNoodler: true, fanActivityEnabled: true });
  await db.insert(noodlerFanActivityState).values({
    id: "fan-day:2026-01-01:UTC",
    updatedAt: new Date().toISOString(),
    plan: JSON.stringify({
      version: 1,
      localDate: "2026-01-01",
      timezone: "UTC",
      nextCreatorOffset: 0,
      runs: [
        {
          id: "run-1",
          scheduledAt: new Date().toISOString(),
          creatorIds: [storedCreator!.id],
          status: "applying",
          claimedAt: new Date().toISOString(),
          finishedAt: null,
          acceptedActivities: [
            {
              id: `run-1-${storedCreator!.id}-${post!.id}-reply-${identity.id}`,
              creatorId: storedCreator!.id,
              actorId: identity.id,
              type: "reply",
              targetPostId: post!.id,
              content: "Event-local reply",
              snapshot: identity.snapshot,
              applied: false,
            },
            {
              id: `run-1-${storedCreator!.id}-${post!.id}-like-${identities[1]!.id}`,
              creatorId: storedCreator!.id,
              actorId: identities[1]!.id,
              type: "like",
              targetPostId: post!.id,
              content: null,
              snapshot: identities[1]!.snapshot,
              applied: false,
            },
          ],
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `future-${index}`,
          scheduledAt: new Date(Date.now() + (index + 1) * 60_000).toISOString(),
          creatorIds: [],
          status: "scheduled",
          claimedAt: null,
          finishedAt: null,
          acceptedActivities: [],
        })),
      ],
    }),
  });
  const recovery = await runNoodlerFanActivity({ db, mode: "automatic", at: new Date("2026-01-01T12:00:00.000Z") });
  assert.equal(recovery.status, "resumed");
  assert.equal(recovery.created, 2);
  const persistedState = await db
    .select()
    .from(noodlerFanActivityState)
    .where(eq(noodlerFanActivityState.id, "fan-day:2026-01-01:UTC"));
  const persistedRun = JSON.parse(persistedState[0]!.plan).runs.find((run: { id: string }) => run.id === "run-1");
  assert.equal(persistedRun.status, "completed");
  assert.ok(persistedRun.acceptedActivities.every((activity: { applied: boolean }) => activity.applied));
  const rowsAfterRecovery = await db.select().from(noodleInteractions).where(eq(noodleInteractions.postId, post!.id));
  assert.equal(rowsAfterRecovery.length, 2);
  assert.equal(await noodle.getAccountById(identity.id), null);
  const duplicate = await noodle.createNoodlerFanInteraction(post!.id, {
    id: `run-1-${storedCreator!.id}-${post!.id}-reply-${identity.id}`,
    creatorAccountId: storedCreator!.id,
    actorId: identity.id,
    actorSnapshot: identity.snapshot,
    runId: "run-1",
    type: "reply",
    content: "Event-local reply",
  });
  assert.equal(duplicate, null);
  await db.update(noodlePosts).set({ access: "locked" }).where(eq(noodlePosts.id, post!.id));
  const blocked = await noodle.createNoodlerFanInteraction(post!.id, {
    id: `run-1-${storedCreator!.id}-${post!.id}-like-${identities[1]!.id}`,
    creatorAccountId: storedCreator!.id,
    actorId: identities[1]!.id,
    actorSnapshot: identities[1]!.snapshot,
    runId: "run-1",
    type: "like",
    content: null,
  });
  assert.equal(blocked, null);
  const rows = await db.select().from(noodleInteractions).where(eq(noodleInteractions.postId, post!.id));
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0]!.actorSnapshot).displayName, identity.snapshot.displayName);

  await db.update(noodlePosts).set({ access: "public" }).where(eq(noodlePosts.id, post!.id));
  const recoveryAt = new Date("2026-01-01T12:00:00.000Z");
  const expiredApplyingPlan = {
    version: 1,
    localDate: "2025-01-01",
    timezone: "UTC",
    nextCreatorOffset: 0,
    runs: [
      {
        id: "expired-applying",
        scheduledAt: "2025-01-01T00:00:00.000Z",
        creatorIds: [storedCreator!.id],
        status: "applying",
        claimedAt: "2025-01-01T00:00:00.000Z",
        finishedAt: null,
        acceptedActivities: [
          {
            id: `expired-applying-${storedCreator!.id}-${post!.id}-reply-${identities[2]!.id}`,
            creatorId: storedCreator!.id,
            actorId: identities[2]!.id,
            type: "reply",
            targetPostId: post!.id,
            content: "Recovered reply",
            snapshot: identities[2]!.snapshot,
            applied: false,
          },
        ],
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `expired-scheduled-${index}`,
        scheduledAt: "2025-01-01T01:00:00.000Z",
        creatorIds: [],
        status: "scheduled",
        claimedAt: null,
        finishedAt: null,
        acceptedActivities: [],
      })),
    ],
  };
  await db.insert(noodlerFanActivityState).values({
    id: "fan-day:2025-01-01:UTC",
    updatedAt: "2025-01-01T00:00:00.000Z",
    plan: JSON.stringify(expiredApplyingPlan),
  });
  const expiredRecovery = await runNoodlerFanActivity({
    db,
    mode: "automatic",
    at: recoveryAt,
  });
  assert.equal(expiredRecovery.status, "resumed");
  assert.equal(expiredRecovery.created, 1);
  const preservedExpiredPlan = await db
    .select()
    .from(noodlerFanActivityState)
    .where(eq(noodlerFanActivityState.id, "fan-day:2025-01-01:UTC"));
  assert.equal(preservedExpiredPlan.length, 1);
  const recoveredExpiredPlan = JSON.parse(preservedExpiredPlan[0]!.plan);
  const recoveredExpiredRun = recoveredExpiredPlan.runs.find((run: { id: string }) => run.id === "expired-applying");
  assert.equal(recoveredExpiredRun.status, "completed");
  assert.equal(recoveredExpiredRun.finishedAt, recoveryAt.toISOString());
  assert.ok(recoveredExpiredRun.acceptedActivities.every((activity: { applied: boolean }) => activity.applied));
} finally {
  rmSync(storageDir, { recursive: true, force: true });
}

process.stdout.write("NoodleR fan activity regression passed.\n");
