# Fluid Container Runtime collaboration DSL

This folder contains a proof-of-concept internal TypeScript DSL for describing collaboration among Fluid clients at the Loader and Container Runtime layers.

Start with [guide.html](./guide.html). It explains DSL concepts, Fluid-specific vocabulary,
architecture grounding, the trace model, and the six source-test restatements that form the
full-circle proof of concept.

## Files

- `model.ts` — Pure serializable semantic model: document topology, commands, the sequenced trace, and expectations.
- `builder.ts` — Progressive fluent grammar that compiles into the semantic model.
- `validator.ts` — Current proof-of-concept combining structural validation, trace checking,
  and semantic derivation. The target responsibility split is described below.
- `scenarios.ts` — Six focused restatements of existing end-to-end tests.
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

The design rule is: **the scenario declares the order; tooling never chooses it.** This is not
a simulated ordering service. There is no leader election, ticket assignment, storage
emulation, or attempt to predict what a real service would choose. The scenario author states
the observable sequenced trace — which is exactly what a real end-to-end test sets up with
paused queues, staged reconnects, and explicit synchronization barriers. The current validator
checks both scenario coherence and modeled behavior; the target architecture separates those
responsibilities among a scenario compiler, runtime executor, and optional reference model.

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
9. Service-generated summary acks and nacks are trace entries, not client commands.
10. Attach state, connection state, and service environment are separate lifecycle axes.
11. Serialized container state records attach-state provenance. Rehydrating serialized
    `Attaching` state yields an attached container.
12. Serialized detached-container state and attached pending-local state are distinct artifact
    kinds with distinct load paths.
13. Expectations are not trusted merely because a scenario declares them. Structural claims
    are checked by the scenario compiler, actual Fluid behavior by the executor, and selected
    independent predictions by an optional reference model.

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
| Summary op | `sequence().summarize(...)` | `MessageType.Summarize` in the total order. |
| Summary outcome | `sequence().summaryAck / summaryNack` | Service-generated sequenced messages. |
| Delivery | `service().deliver(id).through(pos)` | Advance one client's processing cursor. |
| Barrier | `service().synchronize(...)` | Advance the named (or all eligible) clients to the newest position. |

### Ordering metadata

Every trace entry carries the metadata a real `ISequencedDocumentMessage` carries, expressed
symbolically:

| Field | Symbolic form | Default |
| --- | --- | --- |
| `sequenceNumber` | position of the entry in the trace | assigned by declaration order |
| `clientId` | `client` on the entry | required except for service-generated entries |
| `clientSequenceNumber` | `clientSequence` | omitted unless asserted |
| `referenceSequenceNumber` | `referenceSequence`, a position name or `"baseline"` | the submitter's cursor at submission time; the latest prior entry for service-generated messages |
| batch metadata | `batchPosition` | omitted unless the scenario needs batch boundaries |
| virtualization | `virtualization.grouped / compressed / chunk` | none |

### Checked invariants

`expectTrace().toSatisfy()` currently names these checks, and `validator.ts` runs them at the end
of every scenario. This is the proof-of-concept placement, not the intended permanent ownership.

| Invariant | Declared-scenario check | Runtime authority |
| --- | --- | --- |
| `denseTotalOrder` | Scenario compiler: unique symbolic positions and resolvable references; trace-array order is dense by construction | Executor: observed sequence numbers are gap-free |
| `clientSequenceMonotonic` | Scenario compiler: explicitly declared client sequence numbers advance within a connection epoch | Executor: emitted client sequence numbers advance and reset according to the runtime contract |
| `batchContiguity` | Scenario compiler: declared wire entries and markers form one contiguous transmission | Executor: observed batching and virtualization match |
| `causalReferenceSequence` | Scenario compiler: declared references precede entries and are not ahead of the declared submitter cursor | Executor: observed reference sequence numbers obey the protocol contract |
| `wireReconstruction` | Scenario compiler: declared chunk metadata is internally coherent | Executor: actual reconstruction and abandonment behavior |
| `exactlyOnceApplication` | Scenario compiler: one logical operation may enter the declared trace once | Executor, optionally compared with a reference model: actual application and replay reconciliation |
| `orderedDelivery` | Scenario compiler: declared cursor movement is forward and references valid positions | Executor: actual queue, connection, pinning, and delivery behavior |

### Connection and processing position

The proof of concept models service connection as `connected` or `disconnected`, independently
from a client's processing cursor. Disconnecting stops delivery without deleting the shared
trace; reconnecting permits the executor to advance that client through the positions it missed.
Quorum membership and collaboration-window details are deliberately outside this smaller
language.

### Derived facts

The validator maintains, per client, a base position, a processing cursor, an outstanding
submission list, and an applied-operation multiset. From those it derives and checks:

- `expectOperation(op).at(client).toBe(...)` as one mutually exclusive state: `pending`, `sequenced`, `processed`, `acked`, or `notProcessed`;
- `expectOperation(op).at(client).toBeAppliedTimes(n)`;
- `expectDelivery(client).toBe({ loadedAt, processedThrough })`;
- `expectBatch(b).toBeVirtualizedAs({ grouped, compressed, chunked, originalOperationCount, wireMessages })`;
- `expectPendingReplay(client).toPreserve({ batches })`, the client's outstanding submissions
  collapsed to their batches in submission order;
- `expectClient(c).toBe({ attach, connection, environment, dirty, closed, inbound, outbound })`;
- `expectPendingState(p).toContain({ savedOps, stashedOps, containsOperations })`;
- `expectSummary(s).toBe(state)`;
- `expectDataStore(client, ds).toBe(..., { containsOperations })`;
- `expectConvergence(...)`.

This is the current proof-of-concept reference behavior. It made the domain semantics explicit
before an executor existed, but it is not all intended to remain mandatory scenario validation.
The Aspirational backlog classifies these derivations into structural compiler checks, executor
observations, and selected optional reference-model predictions.

Optimistic local application is modeled: a submitted operation takes effect at its submitter
immediately, and processing its own sequenced copy is an acknowledgement rather than a second
application. A container that loads at a position holds the effect of everything sequenced up
to it. Both facts are what make `exactlyOnceApplication` meaningful across stash and replay.

### Deliberate focus

The six scenarios form one narrative arc: create or load a container, submit work, declare its
sequence order, control per-client delivery, summarize and load a snapshot, and preserve pending
work across rehydration. Membership protocol, fork detection, frozen full-state capture,
loading groups, and snapshot-refresh policy were removed from the current language so the
proof demonstrates its central ideas without presenting a catalog of every Container Runtime
feature.

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
- disconnected and connected service operation
- serialized-state provenance for detached versus attaching containers
- pending-local-state capture and online rehydration

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

Facts the trace model encodes directly:

- Grouping collapses a batch into **one** sequenced message; ungrouping clones the outer
  message and assigns synthetic inner client sequence numbers, so many logical ops share one
  sequence number.
- Chunking splits one payload across **many** sequenced messages; only the final chunk carries
  the reconstructed payload, original type, metadata, and compression marker.
- The inbound order is unchunk, decompress, unroll, ungroup, then batch classification.

### Summaries and snapshots

- `packages/runtime/container-runtime/src/summary/summaryCollection.ts`
- `packages/runtime/container-runtime/src/summary/summaryManager.ts`
- `packages/runtime/container-runtime/src/summary/summarizerNode/summarizerNode.ts`
- `packages/runtime/container-runtime/src/summary/summaryDelayLoadedModule/summaryGenerator.ts`

`SummaryCollection` watches the op stream, keys pending summaries by the summary op's own
sequence number, and resolves them through `ISummaryAck.summaryProposal.summarySequenceNumber`.
That is why summary ops, acks, and nacks are trace entries and why an ack must name a summary
op that is already in the trace.

### Driver boundary

- `packages/common/driver-definitions/src/storage.ts`
- `packages/common/driver-definitions/src/urlResolver.ts`

The DSL describes service-backed loading and opaque snapshot/version/summary handles. It must
not encode driver endpoint names, tokens, cache implementations, socket behavior, or concrete
driver classes.

## Evolution architecture: kernel and scenario layers

The Loader/Container Runtime boundary is a useful implementation seam, but scenarios repeatedly
cross it: the Loader constructs a runtime from a snapshot and trailing operations, connection
and delta-stream state govern runtime processing, runtime pending state feeds a later load,
runtime summaries become service snapshots a Loader later consumes, and summary
acknowledgements, reconnect, and resubmission share one sequenced timeline. Splitting these into
unrelated DSLs would require another composition language to share client identity, artifacts,
sequence positions, and time. Keep one scenario language and one semantic model for now, while
maintaining explicit internal layers:

```text
Fluid scenario kernel
|- client, artifact, operation, and symbolic sequence identities
|- shared timeline, trace, and cross-layer invariants
|- Loader scenario layer
|  `- load, attach, connect, snapshot, capture, and rehydrate
|- Runtime scenario layer
|  `- submit, batch, summarize, DataStore operations, and replay
`- Protocol trace layer
   `- sequence, deliver, summary ack, and summary nack
```

The Driver and the DataStore operation boundary remain good external seams: the DSL needs only
interface-level Driver capabilities and observations (the executor selects a concrete
implementation), and DDS payload semantics can stay opaque or move to a future DDS-specific
dialect.

### Tests for a future DSL boundary

A layer is a good candidate for its own authoring dialect when it has:

- a small, stable handoff contract;
- mostly independent state machines and invariants;
- little shared temporal state;
- assertions that remain meaningful without reaching through another layer;
- a distinct executor adapter;
- enough focused scenarios that authors rarely cross the proposed boundary.

If additional conversions reveal natural clusters, focused entry points may be useful:

```ts
loaderScenario(...); // Loader lifecycle without runtime collaboration details
runtimeScenario(...); // Assumes already-loaded clients
fluidScenario(...); // Composes all layers
```

These should remain dialects over the same IR and trace kernel, not separate incompatible
languages. Split validator and executor implementation by layer before splitting authoring
semantics.

### Compiler, executor, renderer, and reference model

The DSL scenario remains the source of truth:

```text
DSL types -> IR -> scenario compiler -> normalized execution plan
                                          |- direct Fluid executor -> observed behavior
                                          |- TypeScript reproduction renderer
                                          `- optional reference model -> predicted behavior

                         observed behavior <-> predicted behavior
```

The scenario compiler should perform only checks that are pure properties of the IR or are
required to produce an unambiguous execution plan: identifier uniqueness, known references,
artifact provenance, internally coherent trace metadata, and legal declared cursor movement.
It should not reproduce changing Container Runtime algorithms merely to predict whether a test
will pass.

The executor should interpret the plan against `ITestObjectProvider`, observe the real
sequenced stream, and remain authoritative for Loader and Runtime behavior. It must not simulate
or choose an ordering-service implementation. A TypeScript renderer should consume the same
plan and expand one scenario into a debuggable Mocha reproduction with explicit harness calls,
DSL step annotations, symbolic sequence names, and captured trace state.

The optional reference model is a small, pure, independent implementation of selected stable
contracts. It consumes the normalized plan or an observed trace and produces predicted
observations; it neither drives Fluid nor decides whether the scenario is structurally valid.
Its purpose is differential conformance, model exploration, and failure diagnosis. It should
not import the production algorithm it is checking, and it should model only rules whose
independent prediction is valuable enough to justify synchronization cost.

Rendered tests should normally be temporary files or CI artifacts, not checked-in generated
sources. Migrate an existing end-to-end test to a checked-in DSL scenario only after the
executor provides equivalent behavior coverage and failure diagnostics. Retain bespoke tests
for DDS semantics, timing, telemetry, performance, fuzzing, implementation-specific behavior,
and concepts intentionally outside this language.

### Validation ownership rule

Keep a dynamic scenario-compiler check only when it is a pure property of the IR, a deliberately
normative declaration contract, or necessary to keep the executor from timing out or producing
an ambiguous failure. Put actual Fluid behavior in the executor. Put an independent prediction
in the optional reference model only when differential testing provides clear value.

The same invariant may intentionally appear at two boundaries. For example, dense declared
trace order belongs in the scenario compiler, while dense sequence numbers emitted by Fluid
belong in executor conformance. Explicitly authored client sequence numbers can be checked for
monotonicity by the compiler, while the runtime's assignment and reconnect reset behavior must
be observed by the executor.

## Converting an end-to-end test

Use two passes: understand the behavior first, then encode it. Do not invent syntax while still
deciphering the source test.

### 1. Ground the behavior

Read the complete test and the production path responsible for its important assertions.
Separate the behavior under test from provider setup, synchronization helpers, sleeps, retries,
and other harness mechanics.

Record a behavior card in working notes or the review discussion:

- the behavior the test proves;
- clients, DataStores, snapshots, summaries, batches, and captured-state artifacts;
- initial Loader and Runtime states;
- submission order;
- required global sequence order;
- each client's relevant processing position;
- observations and assertions;
- details intentionally opaque at the DDS and Driver boundaries.

The checked-in scenario must retain its repository-relative source file, suite, test name, and
line range.

### 2. Attempt the scenario with existing vocabulary

Before extending anything:

1. Declare only logical clients and DataStores.
2. Use opaque DataStore operation identities instead of DDS payload semantics.
3. Separate submission, sequencing, and processing with `client(...)`, `sequence()`, and
   `service()`.
4. Name only sequence positions referenced by later actions or expectations.
5. State meaningful interleavings with `expectOrder`, not JavaScript statement adjacency.
6. Prefer derived expectations over notes or trusted declarations.
7. Close the scenario with `expectTrace().toSatisfy()`.

### 3. Classify every expressibility gap

Do not treat every source-test helper as a missing DSL verb. Classify each gap below and, when
more than one row could apply, prefer the earliest in this order: existing vocabulary, metadata
on an existing event, a new expectation, then a new command or trace-entry kind.

| Gap | Preferred location |
| --- | --- |
| Observable Loader, Runtime, or protocol concept | Candidate core semantic model |
| Additional fact about an existing event | Metadata on that event |
| New fact observable only from running Fluid | Expectation evaluated by the executor |
| Stable contract worth predicting independently | Optional reference-model derivation plus executor comparison |
| Harness control needed to run a declared concept | Executor primitive |
| DDS-specific payload or merge behavior | DDS dialect or retained bespoke test |
| Concrete Driver behavior | Executor profile or retained Driver test |
| Internal detail with no observable consequence | Do not model |

### 4. Apply the extension gate

A new core construct must have:

- production-code evidence;
- a precise, observable semantic definition independent of a test helper;
- explicit ownership by the scenario compiler, executor, or optional reference model;
- a concrete check, observation, or independent prediction at that boundary;
- a reason existing vocabulary is insufficient;
- at least one positive and one negative test;
- preferably multiple source tests, or one fundamental architectural contract;
- a clear decision about its semantic layer and the component that owns its check.

Use this heart check for the implementation-shape questions the gate above does not cover:

- Does it preserve the separation of submission, sequence, and processing?
- Is the IR still plain, JSON-serializable data?
- Does it compose with existing clients, artifacts, and trace entries?
- Does it avoid making the scenario compiler copy a changing runtime algorithm?

If a detail does not pass the gate or heart check, preserving the original bespoke end-to-end
test is better than bloating the core language.

### 5. Implement semantic changes in order

1. Add the smallest serializable command, trace entry, metadata field, or expectation to
   `model.ts`.
2. Document its meaning without reference to builder syntax or a specific executor.
3. Add the narrowest immutable scope method to `builder.ts`.
4. Add only structural and execution-plan checks to the scenario compiler. Until
   `validator.ts` is split, label new checks as structural or provisional reference-model logic.
5. Add executor observation logic for behavior that depends on the running Loader or Runtime.
6. Add optional reference-model logic only for a selected stable contract that benefits from
   independent prediction.
7. Add focused tests at the owning boundary: compiler rejection tests, executor tests, and/or
   differential conformance tests.
8. Add or update a source-grounded scenario and register it in
   `containerRuntimeDslScenarios`.
9. Update this file and `guide.html` when semantics change.
10. Run the focused DSL validation and applicable executor/conformance tests.

Periodically review additions across several converted tests. Merge redundant concepts, move
harness-only controls into the executor, and remove syntax that has not earned its authoring
cost.

### Suggested conversion prompt

```text
Convert this Fluid end-to-end test into a containerRuntimeDsl scenario:

<FILE, SUITE, AND TEST NAME>

First read:
- containerRuntimeDsl/DEV.md
- containerRuntimeDsl/guide.html
- the complete source test
- relevant Loader, ContainerRuntime, protocol, pending-state, summary, and Driver-interface code

Do not begin by designing syntax.

Stage 1 - Semantic decomposition:
1. State the exact behavior the test proves.
2. Identify clients, snapshots, pending-state artifacts, summaries, batches, and DataStores.
3. Separate submission order, global sequence order, and each client's processing position.
4. Distinguish essential domain behavior from test-harness mechanics.
5. Classify checks as structural, runtime observations, or candidates for optional independent
   reference-model prediction.
6. State what remains intentionally opaque at the DDS and Driver boundaries.

Stage 2 - Expressibility:
Attempt to represent the test using the existing DSL.
Classify every missing detail as:
- missing core domain concept
- missing metadata on an existing concept
- missing structural scenario check
- missing runtime expectation or observation
- stable contract that may justify optional reference-model prediction
- executor or harness capability
- DDS-specific behavior
- Driver-specific behavior
- incidental implementation detail that should not be modeled

Do not add a DSL construct merely because the source test calls a particular helper.

Stage 3 - Extension gate:
For every proposed extension, provide:
- production source evidence
- its observable semantic meaning
- why existing vocabulary is insufficient
- the check, observation, or independent prediction it enables
- whether it belongs in the kernel, a scenario layer, the scenario compiler, the executor, or
  the optional reference model
- the smallest IR change that expresses it

Prefer existing vocabulary, then metadata, then an expectation, and only then a new command or
trace-entry kind.

Stage 4 - Implementation:
Implement the scenario and only extensions that pass the gate.
Keep scenario-compiler checks structural. Put actual Fluid behavior in the executor. Add an
optional independent reference-model prediction only when differential conformance justifies
its maintenance cost.
Add positive and negative tests at the owning boundary.
Keep the IR JSON-serializable, client scopes immutable, sequence positions symbolic, DDS
payloads opaque, and Driver behavior interface-level.
Update DEV.md and guide.html when semantics change.
Run the focused DSL validation and applicable executor or conformance tests.
```

## Aspirational

The items below are backlog, not current capabilities. They are intended to keep the DSL useful
as Fluid evolves without turning the validator into an unverified shadow implementation.

### Scenario compiler and validator reduction

Split the current `validator.ts` responsibilities. Retain a scenario compiler that validates
cross-reference integrity, artifact provenance, declared trace structure, and the preconditions
needed to create an unambiguous execution plan. Move implementation-sensitive state prediction
out of mandatory scenario validation.

Audit every existing rule and classify it as:

- static fluent-language constraint;
- structural scenario-compiler check;
- executor observation;
- optional reference-model prediction;
- external observation that cannot be derived from the IR.

Do not add new implementation-sensitive rejection logic before assigning it an executor or
reference-model conformance path.

### Typed scenario references

Replace error-prone string cross-references in the fluent API with typed handles returned by
authoring actions. The first target is operation sequencing:

```ts
const submission = steps.client("main").submitOperation(operation);
const position = steps.sequence().operations("seq-edit", submission);
steps.service().deliver("reader").through(position);
```

Distinguish a durable logical operation from a particular client's submission because reconnect
and replay can submit the same operation more than once. The builder may expose branded
`OperationRef`, `SubmissionRef`, and sequence-position handles while continuing to serialize
plain string IDs into the IR. The scenario compiler still checks provenance and same-scenario
ownership, but common misspellings and wrong reference kinds should fail in TypeScript.

### DataStore attachment and reference relationships

Model the semantic relationship created when one DataStore stores a handle to another. The
current incremental-summary scenario separately declares visibility and an opaque root
operation, so it preserves some effects but loses the root-to-secondary reference edge and the
DataStore attach transition that an executor must realize.

Keep the core concept above DDS payload semantics: declare the source DataStore, target
DataStore, resulting attachment/visibility, and logical submission. A test-fixture adapter may
realize it by storing the target handle in a SharedMap or other minimal DDS. Do not generalize
this into a full GC graph until additional scenarios require GC-specific semantics. DataStore
creation itself should account for a new DataStore needing a tree in its first summary rather
than requiring a synthetic "seed" operation.

### Runtime executor

Build an executor that consumes the normalized execution plan and drives real containers through
`ITestObjectProvider`. It should map Loader and Runtime commands to harness operations, observe
the actual sequenced stream and client state, and evaluate expectations against the running
implementation. It must not simulate or select the ordering service's result.

The first milestone should execute a small cross-layer set covering ordinary collaboration,
paused delivery, pending-state rehydration, and summarization. Failures should identify the DSL
step, symbolic sequence position, expected state, actual state, and nearby trace entries.

### Optional reference model

Extract only selected, high-value semantic derivations from the current validator into a pure
reference model. It should consume a normalized plan or observed trace and return predicted
states or invariant results without driving Fluid, rejecting structural input, or importing the
production implementation it checks.

Initial candidates should be stable protocol contracts where independent prediction aids
diagnosis, such as exactly-once replay reconciliation. Dense declared ordering and explicitly
authored client-sequence monotonicity remain scenario-compiler checks; the corresponding runtime
emissions remain executor observations.

The reference model is optional per rule and per scenario. Absence of a model prediction must
not prevent an executable scenario from running.

### Differential conformance suite

For each rule admitted to the optional reference model, run the same scenario through both the
model and runtime executor, then compare predicted and observed behavior. A disagreement must be
classified as:

- a runtime defect;
- a reference-model defect;
- an executor or observation defect;
- an intentional contract change.

Conformance scenarios should be small and focused on one rule or transition. They complement,
rather than replace, the broader end-to-end scenario set.

### Automated CI drift detection

Run the differential conformance suite in CI whenever relevant Loader, Container Runtime,
protocol, pending-state, summary, or DSL files change. CI should retain the scenario IR, actual
trace, scenario-compiler diagnostics, reference-model prediction when present, and any rendered
TypeScript reproduction as failure artifacts.

Start with path-based triggering and a stable required suite. Expand coverage based on observed
drift rather than attempting to infer every production dependency immediately.

### Rule ownership registry

Give each nontrivial scenario rule durable metadata:

- rule identifier and semantic description;
- owner: fluent types, scenario compiler, executor, optional reference model, or external
  observation;
- classification as normative contract, implementation-sensitive behavior, shared definition,
  or external observation;
- production symbols and source files that provide evidence;
- positive, negative, executor, and differential-conformance scenarios as applicable;
- owner or subsystem when useful.

The registry may begin as typed data beside the scenario compiler and reference model. Tooling
should eventually report rules whose cited production symbols changed without corresponding
conformance coverage or review.

### Compatibility profiles

Support intentional periods where more than one Fluid behavior is valid, such as compatibility
testing across release ranges or a staged protocol transition. Profiles should select explicit
semantic rules or capabilities; they must not become arbitrary collections of scenario-compiler
or reference-model exceptions.

Every profile needs a name, supported version or capability range, rationale, conformance
coverage, and removal or migration condition. Scenarios should remain unchanged where possible,
with the selected profile supplied by the execution environment.

## Explicit limitations

- Signals, GC, aliasing, blob attach, and staging mode are not modeled.
- Quorum membership, collaboration-window/minimum-sequence behavior, read-mode negotiation, and
  protocol noops are not modeled.
- Signal ordering relative to ops is not modeled.
- Driver cache and snapshot-fetch policy, loading groups, frozen full-container-state capture,
  fork/duplicate-batch detection, and dispatch bunching are not modeled.
- Summary tree/handle reuse and DataStore realization remain declarative observations that a
  future executor must check.
- `expectPendingReplay` currently describes named batches only. The validator reports loose
  pending operations instead of silently omitting them; model those as one-operation batches
  when replay order matters.
- There is no executor. The IR is executor-ready but nothing runs it against
  `ITestObjectProvider` yet.
