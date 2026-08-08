# Slice 9a — NoodleR Fan Engagement

Detail implementation contract for Slice 9a. The [NoodleR PR-Split Living
Plan](./noodler-pr-split-living-plan.md) remains authoritative for ordering and
status. This document fixes the 9a behavior and boundaries; it does not change
the living plan's claim that 9a is later and optional.

## Contract

Slice 9a is one bounded slice. It adds quiet, creator-scoped synthetic audience
activity to NoodleR. The activity consists only of likes, replies, and reposts
on eligible existing NoodleR posts. It is ambient activity, not a second
posting system, a named-fan system, or an economy.

The scheduler runs a configurable number of platform runs per local day. Each
configured run is platform-wide: it considers all eligible creators on that
platform, selects at most **12 creators per run**, and makes
at most **one platform-wide LLM invocation for the run**. The model may propose
multiple candidate activities in that single response. Deterministic server
validation, quotas, access checks, deduplication, and anti-spam decide what is
accepted. The implementation must not call the LLM once per creator, post, fan,
or proposed activity.

Each creator may receive at most **four accepted public posts per run**. This is
the per-run target limit across likes, replies, and reposts, not four of each
kind. The limit is applied after target and access validation and before writes.
There are no catch-up bursts: missed runs are forfeited, and restart recovery
may only finish or publish work that was already durably accepted before the
restart.

## Schedule And Settings

Fan activity has its own platform-day plan and its own scheduler leaf. It does
not share automatic-post reserve state, automatic-post attempt claims, next-run
timestamps, or cadence state. A shared scheduler construction or connection
does not imply shared persisted schedule state.

The global NoodleR settings hold defaults for fan activity. The creator page
may hold a per-creator `scheduler.fanActivity` override. Resolution is explicit:
the creator override wins when present; otherwise the global default applies.
Removing the override returns the creator to the current global default. An
override is a typed leaf, not a copy of the global settings object, and changing
the global default does not rewrite existing creator overrides.

The settings contract includes:

- fan activity enabled/disabled globally;
- the configurable automatic-runs-per-local-day schedule ceiling;
- the maximum 12 creators selected per run and maximum four accepted public
  posts per creator per run;
- the audience-archetype weights defined below.

The fixed default is four automatic runs per local day when NoodleR automation
is enabled, and the limits above. The user-facing control may adjust that
automatic schedule within the validated platform limit. A global disable prevents new background
admission and new fan runs; it does not delete accepted activity.

## Audience Archetypes

9a has exactly six archetypes. Their labels and keys are fixed contract data,
not free-form user-entered categories:

| Key | Label | Default weight |
| --- | --- | ---: |
| `ordinary` | Ordinary regular | 6 |
| `eccentric` | Eccentric enthusiast | 2 |
| `crossFandom` | Cross-fandom visitor | 1 |
| `raider` | Raider | 1 |
| `organicDiscovery` | Organic discovery | 1 |
| `freeResource` | Non-adult/free-resource audience | 1 |

Weights are non-negative integers. Zero disables an archetype for that
default or creator override; the weighted selection is deterministic for a
given run seed and does not require an LLM call. At least one weight must be
positive. The six-key shape is validated at the settings boundary and stored
 as a normalized typed value. A creator override may be sparse: its explicit
 values, including zeroes, merge over the current global map and omitted values
 inherit the global configuration.

Archetypes influence the proposed audience flavor and deterministic selection
policy. They do not create durable fan identities, accounts, follower graphs,
or additional provider calls in 9a.

## Identity And Storage

Generation uses an identity-provider seam with a synthetic-only provider in
9a. The seam must make the source replaceable for later named or real-character
work, but 9a does not read, borrow, or write a real character's identity,
memory, relationship state, or chat history.

Anonymous fan activity has no account row. An accepted activity stores only the
event data needed to render and reconcile it, including an event-local author
display snapshot when a reply or repost needs one. The snapshot is not a
profile, handle reservation, identity record, or follower relationship. Do not
create one account row per synthetic fan or one route per anonymous fan.

Every accepted activity receives a stable activity ID before persistence. The
ID is derived from the immutable run identity and the candidate's stable
creator, target-post, and activity-kind slot, and is unique across activity
types and runs. Retries of the same accepted candidate reuse the same ID;
they must not create a second activity or consume another quota. All reads,
writes, retries, and restart reconciliation use this ID as the idempotency
key.

On restart, the service reloads the current local-day run state and accepted
activity IDs, marks already accepted candidates complete, and resumes only
unresolved work from that already-admitted run. It must not re-invoke the LLM
for a completed run, rerun a missed run, or generate a burst to compensate for
offline time. A run response and its candidate/admission state must be durable
enough to make this recovery decision before the process acknowledges the run.

## Access And Admission

9a can target **public NoodleR posts only**. Locked posts, posts whose public
projection is unavailable, and posts that are not visible to the synthetic
audience are excluded before candidate selection. Candidate preselection must
use the public-post projection and must not load or expose locked content to
the model.

Preselection is advisory. Every proposed activity is checked again inside the
transaction that persists it: the target still exists, is still a NoodleR
post, is still public, belongs to an eligible creator, and has not already
received the same accepted activity. The transaction also rechecks the
creator/run quota and activity-kind anti-spam constraints. Any failed check
rejects that candidate without a partial interaction row, access leak, or
quota debit.

Background work uses the existing connection-scoped admission seam. A fan run
may acquire one background lease only when no foreground provider operation
is active and the configured connection has been idle for 30 seconds. It has
at most one background LLM call in flight. A foreground request arriving
after the call starts does not preempt that call, but prevents subsequent
background admission. Failure to acquire the lease leaves the run incomplete
and retries later with normal backoff.

## Quotas And Anti-Spam

The hard limits are enforced server-side, transactionally, and are not trusted
to the model or client:

- at most the configured number of automatic platform runs per platform-local calendar day;
- at most 12 selected creators in a run;
- at most four accepted public-post activities per creator in a run;
- at most one accepted activity of a given kind from the same synthetic
  audience slot to the same target post;
- no duplicate accepted activity ID;
- no repeated reply/repost from the same synthetic slot to the same creator
  within the same run beyond the per-post rule;
- no activity on a target that fails the public-post access check at commit.

The run budget is an admission budget, not a promise of output. Rejected
proposals, duplicate IDs, unavailable targets, provider failures, and empty
eligible sets may leave the run below its maximum. They do not trigger extra
LLM calls, catch-up work, or a larger later run. The one platform-wide LLM
invocation is charged when admitted and attempted, including a failed paid
attempt; local validation and database retries do not create provider budget.

## Manual Runs

The UI may expose a manual **Run fan activity now** action for an explicit
operator request. Manual execution uses the same platform-wide one-call
contract, creator and public-post limits, transactional checks, stable IDs,
and anti-spam rules as background work. It does not bypass the global disable,
creator override, access policy, or connection admission.

A manual run does not consume the automatic platform-day run budget and remains
available after that budget is exhausted. It creates a separate ad hoc run. If
admission is temporarily
blocked by foreground work, the action reports that it was not admitted; it
does not queue an unbounded provider job. Manual work is never a catch-up
mechanism.

## UI Surfaces

Global fan controls live in NoodleR Settings beside the existing automation
controls. They show the enabled state, the configurable automatic daily-run limit, the current
local-day usage, and the six archetype weights. The hard ceilings are presented
as limits, not editable settings. The screen includes a compact run status,
last-run result, and **Run fan activity now** action with disabled, busy,
limit-reached, provider-failure, and no-eligible-post states.

Creator-specific fan controls live on the creator's stage-profile page. They
show whether that creator uses the global default or a local
`scheduler.fanActivity` override, expose the same six integer weights, and
show the creator's accepted count for the current run. The page must make the
override resettable without changing the global setting.

Feed and creator-profile surfaces render accepted likes, replies, and reposts
through the existing viewer access projection. Public activity may be visible
only where its target public post is visible. No anonymous fan profile link,
fan account page, locked-post teaser, or hidden-target count is rendered.

Desktop and mobile surfaces must cover loading, empty, disabled, busy,
limit-reached, provider-error, and no-eligible-post states without implying
that a missed run is owed.

## Explicit Non-Scope

The following are outside 9a and must not be smuggled into its implementation:

- **9b:** support points, economic events, balances, ledgers, or visible
  monetization moments;
- **9c:** persistent named superfans, relationship continuity, superfan
  formation, or named visible moments;
- **9d:** opt-in real-character identity borrowing or any source-character
  identity read/write;
- **9e:** named-fan profiles, handles, follower graphs, or access-filtered
  fan-history routes;
- fan avatars or per-fan image-provider calls;
- engagement on locked, private, mirrored, or public-Noodle posts;
- a per-creator fan clock, catch-up queue, provider job queue, or one-call-per-
  creator fan generation path;
- support points or any claim that synthetic activity represents real users.

## Validation

Implementation validation must prove the contract at operation and UI levels:

- one background run makes no more than one platform-wide LLM request and
  never one request per creator or activity;
- local-day scheduling admits no more than the configured automatic runs;
- creator selection caps at 12 and accepted activity caps at four public posts
  per creator per run;
- all six archetypes persist and validate integer weights, including zero and
  invalid-value rejection, with creator override precedence and reset;
- only public NoodleR posts reach model preselection, and a post becoming
  locked between preselection and commit is rejected transactionally;
- duplicate proposals and retries preserve one stable accepted activity ID and
  one stored activity;
- restart recovery resumes unresolved admitted work without a second LLM call,
  catch-up burst, or duplicate activity;
- background admission yields to active foreground work and respects the
  30-second idle gate;
- provider failure, rejected candidates, and empty eligibility consume no
  extra run or catch-up budget;
- manual execution follows the same activity limits, remains outside the
  automatic run budget, and does not queue unbounded work;
- no synthetic account rows, durable anonymous fan identities, locked-content
  projections, or out-of-scope 9b/9c/9d/9e data are created;
- desktop and mobile settings, creator-page, feed, and profile surfaces cover
  the listed states with localized accessible labels and no misleading
  catch-up language.

The implementation remains subject to the repository's normal checks, focused
regression coverage for scheduling/access/idempotency, and browser proof for
the settings, creator-page, and feed surfaces. This document records the
validation claims to prove; it is not evidence that those checks have already
passed.
