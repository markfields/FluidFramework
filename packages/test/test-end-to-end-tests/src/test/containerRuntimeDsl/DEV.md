# Fluid Container Runtime collaboration DSL

This folder contains a proof-of-concept internal TypeScript DSL for describing collaboration among Fluid clients at the Loader and Container Runtime layers.

Start with [guide.html](./guide.html). It explains DSL concepts, Fluid-specific vocabulary, architecture grounding, the validator, and all ten source-test restatements.

## Files

- `model.ts` — Pure serializable semantic model. It contains no executable callbacks or Fluid test-harness objects.
- `builder.ts` — Progressive fluent grammar that compiles into the semantic model.
- `validator.ts` — Deterministic domain validator for identifiers, lifecycle guards, artifact provenance, and runtime-option compatibility.
- `scenarios.ts` — Ten restatements of existing end-to-end tests.
- `fluidScenarioDsl.spec.ts` — Focused tests for examples, serializability, grammar, and negative validation.
- `guide.html` — Comprehensive standalone guide.

## Design invariants

1. The DSL stops at the DataStore operation boundary. DDS payload semantics remain opaque.
2. Driver behavior is represented only through interface-level capabilities and observations.
3. Client scopes are immutable. `steps.client("alice")` returns an object permanently bound to Alice.
4. The builder never stores a mutable "current client."
5. The semantic model is plain data and survives a JSON round trip.
6. Commands and observations remain distinct. A service acknowledgement is a service-boundary stimulus, not a client action.
7. `ConnectionState`, connection mode, read-only state, and service environment are orthogonal concepts.
8. Serialized container state records attach-state provenance. Rehydrating serialized `Attaching` state yields an attached container.
9. `getPendingLocalState` output and `captureFullContainerState` output are distinct artifact kinds.
10. The validator checks representability and lifecycle legality; it does not pretend to simulate the ordering service, storage service, or Container Runtime.

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

### Container Runtime

- `packages/runtime/container-runtime/src/containerRuntime.ts`
- `packages/runtime/container-runtime/src/channelCollection.ts`
- `packages/runtime/container-runtime/src/dataStoreContext.ts`
- `packages/runtime/container-runtime/src/pendingStateManager.ts`

The DSL treats DataStore creation, visibility, realization, op submission, dirty/saved observations, pending state, and summary participation as Container Runtime concepts. It does not model DDS-specific operation types.

### Operation lifecycle and virtualization

- `packages/runtime/container-runtime/src/opLifecycle/README.md`
- `packages/runtime/container-runtime/src/opLifecycle/outbox.ts`
- `packages/runtime/container-runtime/src/opLifecycle/remoteMessageProcessor.ts`
- `packages/runtime/container-runtime/src/opLifecycle/opGroupingManager.ts`
- `packages/runtime/container-runtime/src/opLifecycle/opSplitter.ts`

In this codebase, op virtualization means the symmetric outbound/inbound transforms for:

1. grouping,
2. compression,
3. chunking.

Pending state stores original, unvirtualized runtime operations so reconnect replay can preserve logical batch boundaries.

### Summaries and snapshots

- `packages/runtime/container-runtime/src/summary/summaryCollection.ts`
- `packages/runtime/container-runtime/src/summary/summaryManager.ts`
- `packages/runtime/container-runtime/src/summary/summarizerNode/summarizerNode.ts`
- `packages/runtime/container-runtime/src/summary/summaryDelayLoadedModule/summaryGenerator.ts`
- `packages/loader/container-loader/src/snapshotRefresher.ts`

The semantic model distinguishes:

- summary stages: `base`, `generate`, `upload`, `submit`
- summary states: `local`, `broadcast`, `acked`, `nacked`
- summary trees versus reused handles
- summary acknowledgement from later snapshot refresh

### Driver boundary

- `packages/common/driver-definitions/src/storage.ts`
- `packages/common/driver-definitions/src/urlResolver.ts`

The DSL may describe:

- service-backed versus frozen/offline environments
- requested connection mode
- snapshot fetch purpose and count
- opaque snapshot/version/summary handles

It must not encode driver endpoint names, tokens, cache implementations, concrete socket behavior, or concrete driver classes.

## Adding a scenario

1. Select one existing end-to-end test and record its repository-relative file, suite, test name, and useful line range.
2. Declare only logical clients and DataStores. Use a DataStore operation label instead of DDS-specific payload semantics.
3. Express the timeline through client, processing, and service scopes.
4. Record observations explicitly; do not make the validator infer distributed behavior.
5. Add the scenario to `containerRuntimeDslScenarios`.
6. Run the focused type check and `fluidScenarioDsl.spec.ts`.

## Extending the language

Add a feature in this order:

1. Add a serializable command or expectation to `model.ts`.
2. Add an immutable scope method to `builder.ts`.
3. Add reference and lifecycle validation to `validator.ts`.
4. Add at least one positive scenario and one negative validation test.
5. Update `guide.html`.

Potential future surfaces include staging-mode commit/discard, signals, alias conflict handling, summary nack/retry behavior, explicit saved-op replay, and a harness adapter that executes the IR against `ITestObjectProvider` and `IOpProcessingController`.
