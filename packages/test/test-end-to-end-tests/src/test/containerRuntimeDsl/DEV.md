# Fluid Container Runtime collaboration DSL

This folder contains a proof-of-concept internal TypeScript DSL for describing collaboration among Fluid clients at the Loader and Container Runtime layers.

Start with [guide.html](./guide.html). It explains DSL concepts, Fluid-specific vocabulary, architecture grounding, the trace model, the validator, and all ten source-test restatements.

## Files

- `model.ts` — Pure serializable semantic model: document topology, commands, the sequenced trace, and expectations.
- `builder.ts` — Progressive fluent grammar that compiles into the semantic model.
- `validator.ts` — Deterministic domain validator and trace checker.
- `scenarios.ts` — Ten restatements of existing end-to-end tests.
- `fluidScenarioDsl.spec.ts` — Focused positive and negative tests.
- `guide.html` — Comprehensive standalone guide.

## The central idea: declare the order, do not decide it

A Fluid collaboration scenario is a distributed execution. Its meaning depends on three
different orders that an ordinary test script silently collapses into one:

1. **Submission order** — when each client offered an operation to its own runtime.
2. **Sequence order** — the single total order the ordering service chose.
3. **Processing order and position** — how far each client has advanced through that total order.

Version 1 of this DSL had only JavaScript statement order and a `synchronize()` barrier, so it
could not describe any scenario whose meaning lives in the gaps between those three orders.
Version 2 makes them separate first-class concepts.

The design rule is: **the scenario declares the order; the validator checks the declaration.**
This is not a simulated ordering service. There is no leader election, no ticket assignment,
no storage emulation, and no attempt to predict what a real service would do. The scenario
author states the observable sequenced trace — which is exactly what a real end-to-end test
sets up with paused queues, staged reconnects, and explicit synchronization barriers — and the
validator rejects traces and expectations that violate the Fluid sequencing contract.

## Design invariants

1. The DSL stops at the DataStore operation boundary. DDS payload semantics remain opaque.
2. Protocol, container, and DataStore op kinds, and the ordering metadata that accompanies
   them, are modeled because the architecture requires them.
3. Driver behavior is represented only through interface-level capabilities and observations.
   No concrete driver, endpoint, token, socket, or cache detail appears.
4. Client scopes are immutable. `steps.client("alice")` returns an object permanently bound to Alice.
5. The builder never stores a mutable "current client."
6. The semantic model is plain data and survives a JSON round trip.
7. Submission, sequencing, and processing are three distinct events with three distinct verbs.
8. Sequence positions are symbolic names, not integers. The trace order defines the sequence
   numbers; a scenario never writes `sequenceNumber: 7`.
9. Service-generated messages — summary acks and nacks, join, leave, noop — are trace entries,
   not client commands.
10. `ConnectionState`, connection mode, read-only state, and service environment are orthogonal.
11. Serialized container state records attach-state provenance. Rehydrating serialized
    `Attaching` state yields an attached container.
12. `getPendingLocalState` output and `captureFullContainerState` output are distinct artifact kinds.
13. Expectations the validator can derive from the trace are derived and checked, not trusted.
    Only genuinely external observations — snapshot fetch counts, summary tree/handle reuse,
    DataStore realization, summary stage — remain declarative.

## The trace model

### Vocabulary

| Concept | Verb | Meaning |
| --- | --- | --- |
| Logical operation | `client(id).submitOperation` | An opaque DataStore op with a durable identity. |
| Logical batch | `client(id).submitBatch` | A set of logical ops flushed together. |
| Replay | `client(id).resubmitBatch` | The same logical batch offered again, possibly by another session. |
| Concurrency | `concurrently(...)` | Submissions with no relative order. |
| Sequencing | `sequence().operations(...)` | One wire message enters the total order. |
| Wire fragment | `sequence().chunk(...)` | A non-final chunk that reconstructs nothing. |
| Membership | `sequence().join / leave` | A join is the point a client becomes live and has caught up; a leave retires it from the live set. |
| Window nudge | `sequence().noop` | Moves a live client's reference position without carrying an operation. |
| Summary op | `sequence().summarize(...)` | `MessageType.Summarize` in the total order. |
| Summary outcome | `sequence().summaryAck / summaryNack` | Service-generated sequenced messages. |
| Delivery | `service().deliver(id).through(pos)` | Advance one client's processing cursor. |
| Barrier | `service().synchronize(...)` | Advance the named (or all eligible) clients to the newest position. |
| Dispatch | `expectBunches(position)` | How one sequenced message splits into per-DataStore bunches. |

### Ordering metadata

Every trace entry carries the metadata a real `ISequencedDocumentMessage` carries, expressed
symbolically:

| Field | Symbolic form | Default |
| --- | --- | --- |
| `sequenceNumber` | position of the entry in the trace | assigned by declaration order |
| `clientId` | `client` on the entry | required except for service-generated entries |
| `clientSequenceNumber` | `clientSequence` | omitted unless asserted |
| `referenceSequenceNumber` | `referenceSequence`, a position name or `"baseline"` | the submitter's cursor at submission time; the latest prior entry for service-generated messages |
| `minimumSequenceNumber` | `minimumSequence`, a position name or `"baseline"` | carried forward from the previous entry |
| batch metadata | `batchPosition`, `batchId` | derived identity `client_[clientSequence]` when omitted |
| virtualization | `virtualization.grouped / compressed / chunk` | none |

### Checked invariants

`expectTrace().toSatisfy()` names them; the validator also runs the aggregate ones once at the
end of every scenario.

| Invariant | Enforced by |
| --- | --- |
| `denseTotalOrder` | unique position names, resolvable references, reserved names rejected |
| `clientSequenceMonotonic` | client sequence numbers advance within one connection epoch |
| `batchContiguity` | one client, one reference position, contiguous positions, well-formed begin/end markers |
| `causalReferenceSequence` | a reference position must already be processed by its submitter and must precede the entry |
| `minimumSequenceMonotonic` | never decreases, never passes the submitting client's reference position, never passes the least reference position among live write clients |
| `wireReconstruction` | chunk runs are complete and consecutive, or abandoned by a submitter that lost its connection |
| `exactlyOnceApplication` | no client applies a logical operation twice, including across replay |
| `orderedDelivery` | cursors move forward only, never past a pinned position, never while a queue is paused or a client is disconnected or frozen |

### Membership and catch-up

`ConnectionState` is `disconnected`, `catchingUp`, or `connected`. A client passes through
`catchingUp` only when the scenario states its membership with a `join` entry; otherwise
obtaining a connection is one step. This is opt-in per client, so a scenario pays for the
precision only where it needs it.

A join entry means three things at once, matching `connectionStateHandler.ts`: the client is a
live member from that position, it has processed everything ordered before it, and only from
there can its own submissions be sequenced. A client whose inbound queue is paused stays
`catchingUp` until it actually processes its join.

Losing a connection does not retire a membership; only a sequenced `leave` does, which is why a
reconnecting client waits for its own leave before it is live again. Until then the retiring
membership still pins the collaboration window at its old reference position. A leave is legal
once the client is no longer `connected`, so it may arrive after the replacement connection is
already established.

### Derived facts

The validator maintains, per client, a base position, a processing cursor, an outstanding
submission list, and an applied-operation multiset. From those it derives and checks:

- `expectOperation(op).at(client).toBe(...)` as one mutually exclusive state: `pending`, `sequenced`, `processed`, `acked`, or `notProcessed`;
- `expectOperation(op).at(client).toBeAppliedTimes(n)`;
- `expectDelivery(client).toBe({ loadedAt, processedThrough })`;
- `expectBatch(b).toBeVirtualizedAs({ grouped, compressed, chunked, originalOperationCount, wireMessages })`;
- `expectBunches(position).toBe([...])`, splitting one sequenced message wherever the target
  DataStore changes, mirroring `channelCollection.ts`;
- `expectPendingReplay(client).toPreserve({ batches })`, the client's outstanding submissions
  collapsed to their batches in submission order;
- `expectClient(c).toBe({ attach, connection, environment, dirty, closed, inbound, outbound })`;
- `expectPendingState(p).toContain({ savedOps, stashedOps, containsOperations })`;
- `expectSummary(s).toBe(state)`;
- `expectDataStore(client, ds).toBe(..., { containsOperations })`;
- `expectConvergence(...)`.

Optimistic local application is modeled: a submitted operation takes effect at its submitter
immediately, and processing its own sequenced copy is an acknowledgement rather than a second
application. A container that loads at a position holds the effect of everything sequenced up
to it. Both facts are what make `exactlyOnceApplication` meaningful across stash and replay.

### Forking is derived, not declared

A container that sees its own outstanding batch identity arrive under a different client
identity closes rather than apply the work twice, matching `pendingStateManager.ts:596-650`.
The validator derives this while advancing a cursor: the container stops at the position before
the offending entry, its phase becomes closed, and its outcome becomes `forkedContainer`. No
scenario declares an exemption, and `exactlyOnceApplication` still holds, because the container
never applied the operation a second time.

This matters because without it the whole family of fork and duplicate-detection tests would be
unwritable: their subject is a failure that an unconditional exactly-once invariant would
otherwise reject as an invalid scenario.

### Authoring cost, measured

Separating submission from sequencing costs roughly half again as many lines across the ten
restatements. Of 46 sequenced entries, 9 carry no metadata beyond the operations they deliver,
and only 5 are both metadata-free and never referenced again. Those 5 are the true ceremony;
the other 41 either carry ordering metadata or have their position named by a later step.

A combined `submitAndSequence` verb was considered and rejected. It would not have damaged the
model, since the intermediate representation would still hold two records, but it would have
added a second way to say a common thing in exchange for shortening 11% of entries.

## Architecture grounding

### Loader and container lifecycle

- `packages/loader/container-loader/src/loader.ts`
- `packages/loader/container-loader/src/container.ts`
- `packages/loader/container-loader/src/connectionState.ts`
- `packages/loader/container-loader/src/connectionStateHandler.ts`
- `packages/loader/container-loader/src/serializedStateManager.ts`
- `packages/loader/container-loader/src/createAndLoadContainerUtils.ts`

The modeled lifecycle preserves:

- `Detached -> Attaching -> Attached`
- `Disconnected`, `EstablishingConnection`, `CatchingUp`, and `Connected`
- serialized-state provenance for detached versus attaching containers
- ordinary pending-local-state capture versus self-contained full-container capture

### Delta manager and the sequencing boundary

- `packages/loader/container-loader/src/deltaManager.ts`
- `packages/loader/container-loader/src/deltaQueue.ts`
- `packages/loader/container-loader/src/connectionManager.ts`
- `packages/common/driver-definitions/src/storage.ts`
- `packages/common/driver-definitions/src/protocol/protocol.ts`

The delta manager only advances on `sequenceNumber === lastQueuedSequenceNumber + 1` and throws
`DataCorruptionError("Found a non-Sequential sequenceNumber")` on delivery of a non-sequential
op, so a dense total order is a contract, not an implementation detail. `DeltaQueue.pause()` and
`resume()` are what the `IOpProcessingController` harness manipulates, which is why a per-client
processing cursor is the right abstraction for "this client has not seen that op yet."

### Container Runtime

- `packages/runtime/container-runtime/src/containerRuntime.ts`
- `packages/runtime/container-runtime/src/channelCollection.ts`
- `packages/runtime/container-runtime/src/dataStoreContext.ts`
- `packages/runtime/container-runtime/src/pendingStateManager.ts`
- `packages/runtime/container-runtime/src/deltaManagerProxies.ts`

Resubmission assigns a fresh client sequence number and a fresh reference sequence number
(`containerRuntime.ts` `submit`, `outbox.ts` `sendBatch`), which is why client-sequence
monotonicity is scoped to a connection epoch and reference positions are re-derived on replay.

### Operation lifecycle and virtualization

- `packages/runtime/container-runtime/src/opLifecycle/README.md`
- `packages/runtime/container-runtime/src/opLifecycle/outbox.ts`
- `packages/runtime/container-runtime/src/opLifecycle/batchManager.ts`
- `packages/runtime/container-runtime/src/opLifecycle/remoteMessageProcessor.ts`
- `packages/runtime/container-runtime/src/opLifecycle/opGroupingManager.ts`
- `packages/runtime/container-runtime/src/opLifecycle/opSplitter.ts`
- `packages/runtime/container-runtime/src/opLifecycle/opCompressor.ts`
- `packages/runtime/container-runtime/src/opLifecycle/duplicateBatchDetector.ts`

Facts the trace model encodes directly:

- Grouping collapses a batch into **one** sequenced message; ungrouping clones the outer
  message and assigns synthetic inner client sequence numbers, so many logical ops share one
  sequence number.
- Chunking splits one payload across **many** sequenced messages; only the final chunk carries
  the reconstructed payload, original type, metadata, and compression marker.
- The inbound order is unchunk, decompress, unroll, ungroup, then batch classification.
- A wire batch identity is an explicit `batchId` or the derived `${clientId}_[${batchStartCsn}]`,
  and `DuplicateBatchDetector` evicts entries older than the inbound minimum sequence number.
- Batch-id tracking is derived from turn-based flushing plus grouped batching unless the
  `Fluid.ContainerRuntime.DisableBatchIdTracking` gate is represented by
  `disableBatchIdTracking`.

### Summaries and snapshots

- `packages/runtime/container-runtime/src/summary/summaryCollection.ts`
- `packages/runtime/container-runtime/src/summary/summaryManager.ts`
- `packages/runtime/container-runtime/src/summary/summarizerNode/summarizerNode.ts`
- `packages/runtime/container-runtime/src/summary/summaryDelayLoadedModule/summaryGenerator.ts`
- `packages/loader/container-loader/src/snapshotRefresher.ts`

`SummaryCollection` watches the op stream, keys pending summaries by the summary op's own
sequence number, and resolves them through `ISummaryAck.summaryProposal.summarySequenceNumber`.
That is why summary ops, acks, and nacks are trace entries and why an ack must name a summary
op that is already in the trace.

### Driver boundary

- `packages/common/driver-definitions/src/storage.ts`
- `packages/common/driver-definitions/src/urlResolver.ts`

The DSL may describe service-backed versus frozen/offline environments, requested connection
mode, snapshot fetch purpose and count, and opaque snapshot/version/summary handles. It must
not encode driver endpoint names, tokens, cache implementations, socket behavior, or concrete
driver classes.

## Adding a scenario

1. Select one existing end-to-end test and record its repository-relative file, suite, test name, and line range.
2. Declare only logical clients and DataStores. Use a DataStore operation label instead of DDS payload semantics.
3. Separate the three orders: submit with `client(...)`, order with `sequence()`, deliver with `service()`.
4. Name only the sequence positions the scenario refers to later.
5. State the intended interleaving with `expectOrder`, not with statement adjacency.
6. Close with `expectTrace().toSatisfy()`.
7. Add the scenario to `containerRuntimeDslScenarios`.
8. Run the focused type check and `fluidScenarioDsl.spec.ts`.

## Extending the language

1. Add a serializable command, trace entry, or expectation to `model.ts`.
2. Add an immutable scope method to `builder.ts`.
3. Add reference, lifecycle, and trace validation to `validator.ts`.
4. Add at least one positive scenario and one negative validation test.
5. Update `guide.html`.

## Explicit limitations

- Signals, GC, aliasing, blob attach, and staging mode are not modeled.
- Quorum proposals, accepts, and rejects are not modeled. Membership is modeled through `join`
  and `leave`, and the collaboration window is bounded by the least reference position among
  live write clients, but the validator never computes a minimum sequence number for the
  scenario; it only rejects a declared one that violates those bounds.
- Signal ordering relative to ops is not modeled.
- Snapshot fetch counts, summary tree/handle reuse, DataStore realization, and summary stage
  remain declarative observations that a future executor must check. So does `rebasedBatches`,
  because rebasing happens before anything reaches the total order and leaves no trace to check.
- A read-mode connection cannot sequence pending submissions and is excluded from the
  collaboration-window floor. `connect()` models the transition to a write connection; the DSL
  does not yet expose an option for reconnecting explicitly in read mode.
- `deltaConnection: "delayed"` records that the live delta stream is deferred. The validator
  models that client as disconnected; storage-based catch-up before `connect()` is not yet a
  separate delivery source.
- `expectPendingReplay` currently describes named batches only. The validator reports loose
  pending operations instead of silently omitting them; model those as one-operation batches
  when replay order matters.
- Bunching is derived from the target DataStore only. The Container Runtime also splits a bunch
  when the inner op type changes, and op types below the DataStore boundary stay opaque here.
- There is no executor. The IR is executor-ready but nothing runs it against
  `ITestObjectProvider` yet.
