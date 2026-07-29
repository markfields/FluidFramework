/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type BatchDefinition,
	type CapturedContainerStateKind,
	type ClientDefinition,
	type ConnectionEnvironment,
	type ContainerOutcome,
	type ConnectionState,
	type DataStoreDefinition,
	type FluidScenario,
	type LoadOptions,
	type OperationDeliveryState,
	type OperationsTraceEntry,
	type RuntimeConfiguration,
	type ScenarioCommand,
	type ScenarioExpectation,
	type SequenceRef,
	type SequenceRelation,
	type SubmissionCommand,
	type TraceEntry,
	type TraceInvariant,
	allTraceInvariants,
	baselineSequenceRef,
	latestSequenceRef,
	reservedSequenceRefs,
} from "./model.js";

export interface ScenarioValidationIssue {
	readonly path: string;
	readonly message: string;
}

export class ScenarioValidationError extends Error {
	public constructor(public readonly issues: readonly ScenarioValidationIssue[]) {
		super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
		this.name = "ScenarioValidationError";
	}
}

type AddIssue = (path: string, message: string) => void;

interface ClientValidationState {
	readonly definition: ClientDefinition;
	phase: "notLoaded" | "open" | "closed";
	attach?: "detached" | "attaching" | "attached";
	connection?: ConnectionState;
	environment: ConnectionEnvironment;
	inbound: "running" | "paused";
	outbound: "running" | "paused";
	/**
	 * Bumped whenever the client obtains a new connection. Client sequence numbers restart
	 * with each connection, so monotonicity is only meaningful inside one epoch.
	 */
	connectionEpoch: number;
	lastClientSequence?: number;
	/**
	 * Position of this client's join message while it is a live member of the collaboration.
	 */
	joinedAt?: number;
	/**
	 * The reference position this client currently pins for the collaboration window.
	 */
	liveReference: number;
	connectionMode?: "read" | "write";
	readOnly?: boolean;
	outcome?: ContainerOutcome;
	/**
	 * Wire batch identities this container is still waiting to have acknowledged. Seeing one of
	 * them arrive under a different client identity means the session forked.
	 */
	readonly pendingBatchIdentities: Set<string>;
	/**
	 * Position the container loaded at: its initial sequence number.
	 */
	basePosition: number;
	/**
	 * Position the container has processed through.
	 */
	cursor: number;
	pinnedAt?: number;
	/**
	 * Trace position at the moment this client most recently lost its connection.
	 */
	disconnectedAfter?: number;
	/**
	 * Logical operations submitted by this client that no entry has carried yet.
	 */
	pending: string[];
	/**
	 * How many times this container applied each logical operation.
	 */
	applied: Map<string, number>;
	/**
	 * Operations this container applied optimistically before they were sequenced. Processing
	 * their own sequenced copy is an acknowledgement, not a second application.
	 */
	locallyApplied: Set<string>;
}

interface OperationRecord {
	readonly id: string;
	readonly dataStore: string;
	readonly batch?: string;
}

interface BatchRecord {
	readonly id: string;
	readonly definition: BatchDefinition;
	/**
	 * Trace positions of every wire message that carried part of this batch.
	 */
	readonly entries: number[];
	submissions: number;
}

interface SnapshotRecord {
	/**
	 * Trace position the snapshot content corresponds to.
	 */
	readonly basePosition: number;
}

interface PendingStateRecord {
	readonly kind: CapturedContainerStateKind;
	readonly basePosition: number;
	readonly cursor: number;
	readonly savedOps: number;
	readonly stashed: readonly string[];
}

interface SummaryRecord {
	readonly client: string;
	/**
	 * The summarizer's processing position when the summary was generated.
	 */
	readonly referenceCursor: number;
	sequencedAt?: number;
	state: "local" | "broadcast" | "acked" | "nacked";
}

interface DeliveryAttempt {
	readonly client: string;
	readonly from: number;
	readonly to: number;
	readonly path: string;
	readonly rejection?: string;
}

interface TraceRecord {
	readonly entry: TraceEntry;
	readonly index: number;
	readonly path: string;
	readonly referenceIndex: number;
	readonly minimumIndex: number;
	/**
	 * The submitter's connection epoch, because client sequence numbers restart per connection.
	 */
	readonly epoch: number;
	/**
	 * The furthest position the submitter could legally have referenced.
	 */
	readonly maxReference: number;
	/**
	 * The identity a peer would use for duplicate detection.
	 */
	readonly effectiveBatchId?: string;
	readonly explicitBatchId: boolean;
}

interface ValidationContext {
	readonly scenario: FluidScenario;
	readonly addIssue: AddIssue;
	readonly clients: Map<string, ClientValidationState>;
	readonly dataStores: ReadonlyMap<string, DataStoreDefinition>;
	readonly createdDataStores: Set<string>;
	readonly visibleDataStores: Set<string>;
	readonly serializedContainers: Map<string, "detached" | "attaching">;
	readonly snapshots: Map<string, SnapshotRecord>;
	readonly pendingStates: Map<string, PendingStateRecord>;
	readonly summaries: Map<string, SummaryRecord>;
	readonly operations: Map<string, OperationRecord>;
	readonly batches: Map<string, BatchRecord>;
	/**
	 * Trace position where each operation was first carried by a non-duplicate entry.
	 */
	readonly sequencedOperations: Map<string, number>;
	/**
	 * The submitter's processing position when it last offered this operation.
	 */
	readonly submissionReference: Map<string, number>;
	readonly trace: TraceRecord[];
	readonly positions: Map<string, number>;
	readonly batchIdOwners: Map<string, number>;
	/**
	 * Clients whose connection lifecycle this scenario states through protocol join messages.
	 */
	readonly joiningClients: ReadonlySet<string>;
	readonly deliveries: DeliveryAttempt[];
	/**
	 * Violations attributed to a named trace invariant and reported when that invariant is
	 * evaluated, so `expectTrace().toSatisfy([...])` is meaningful for every name it accepts.
	 */
	readonly deferred: Map<TraceInvariant, ScenarioValidationIssue[]>;
	readonly emittedIssues: Set<string>;
	/**
	 * Operations that reached a client through pending-state rehydration. Replaying one under a
	 * new client identity only works if the original batch identity travels with it.
	 */
	readonly replayedOperations: Set<string>;
	usesFullOfflineState: boolean;
}

export function assertValidScenario(scenario: FluidScenario): void {
	const issues = validateScenario(scenario);
	if (issues.length > 0) {
		throw new ScenarioValidationError(issues);
	}
}

export function validateScenario(scenario: FluidScenario): readonly ScenarioValidationIssue[] {
	const issues: ScenarioValidationIssue[] = [];
	const addIssue: AddIssue = (path, message) => {
		issues.push({ path, message });
	};

	validateHeader(scenario, addIssue);
	validateRuntimeConfiguration(scenario, addIssue);

	const context: ValidationContext = {
		scenario,
		addIssue,
		clients: createClientStates(scenario.clients, addIssue),
		dataStores: new Map(
			scenario.document.dataStores.map((dataStore) => [dataStore.id, dataStore]),
		),
		createdDataStores: new Set(
			scenario.document.dataStores
				.filter((dataStore) => dataStore.initiallyVisible !== false)
				.map((dataStore) => dataStore.id),
		),
		visibleDataStores: new Set(
			scenario.document.dataStores
				.filter((dataStore) => dataStore.initiallyVisible !== false)
				.map((dataStore) => dataStore.id),
		),
		serializedContainers: new Map(),
		snapshots: new Map(),
		pendingStates: new Map(),
		summaries: new Map(),
		operations: new Map(),
		batches: new Map(),
		sequencedOperations: new Map(),
		submissionReference: new Map(),
		trace: [],
		positions: new Map(),
		batchIdOwners: new Map(),
		joiningClients: collectJoiningClients(scenario),
		deliveries: [],
		deferred: new Map(),
		emittedIssues: new Set(),
		replayedOperations: new Set(),
		usesFullOfflineState: false,
	};

	validateUnique(
		scenario.document.dataStores.map((dataStore) => dataStore.id),
		"document.dataStores",
		"DataStore",
		addIssue,
	);

	for (const [index, step] of scenario.steps.entries()) {
		const path = `steps[${index}]`;
		if (step.kind === "command") {
			validateCommand(context, step.command, path);
		} else if (step.kind === "expectation") {
			validateExpectation(context, step.expectation, path);
		} else if (step.text.trim().length === 0) {
			addIssue(path, "Notes must contain text.");
		}
	}

	checkTraceInvariants(context, allTraceInvariants, "trace");
	validateOfflineRequirements(context);

	return issues;
}

// ---------------------------------------------------------------------------
// Header and configuration
// ---------------------------------------------------------------------------

function validateHeader(scenario: FluidScenario, addIssue: AddIssue): void {
	if (scenario.name.trim().length === 0) {
		addIssue("name", "Scenario name must not be empty.");
	}
	if (!scenario.source.file.startsWith("packages/test/test-end-to-end-tests/")) {
		addIssue("source.file", "Source must be a repository-relative end-to-end test path.");
	}
	if (scenario.source.suite.trim().length === 0) {
		addIssue("source.suite", "Source suite must not be empty.");
	}
	if (scenario.source.test.trim().length === 0) {
		addIssue("source.test", "Source test must not be empty.");
	}
	if (scenario.coverage.length === 0) {
		addIssue("coverage", "At least one coverage area is required.");
	}
	validateUnique(scenario.coverage, "coverage", "Coverage area", addIssue);
}

function validateRuntimeConfiguration(scenario: FluidScenario, addIssue: AddIssue): void {
	const runtime = scenario.document.runtime;
	if (runtime?.compression !== undefined && runtime.enableGroupedBatching !== true) {
		addIssue("document.runtime.compression", "Compression requires grouped batching.");
	}
	if (runtime?.chunkSizeInBytes !== undefined && runtime.compression === undefined) {
		addIssue(
			"document.runtime.chunkSizeInBytes",
			"Chunking applies after compression and requires compression to be enabled.",
		);
	}
	if (
		scenario.document.dataStores.some((dataStore) => dataStore.loadingGroupId !== undefined) &&
		runtime?.useLoadingGroupIdForSnapshotFetch !== true
	) {
		addIssue(
			"document.runtime.useLoadingGroupIdForSnapshotFetch",
			"Loading-group DataStores require loading-group snapshot fetching.",
		);
	}
	if (
		runtime?.compression !== undefined &&
		(!Number.isFinite(runtime.compression.minimumBatchSizeInBytes) ||
			runtime.compression.minimumBatchSizeInBytes < 0)
	) {
		addIssue(
			"document.runtime.compression.minimumBatchSizeInBytes",
			"Compression threshold must be a finite non-negative number.",
		);
	}
	if (
		runtime?.chunkSizeInBytes !== undefined &&
		(!Number.isFinite(runtime.chunkSizeInBytes) || runtime.chunkSizeInBytes <= 0)
	) {
		addIssue(
			"document.runtime.chunkSizeInBytes",
			"Chunk size must be a finite positive number.",
		);
	}
}

function isBatchIdTrackingEnabled(runtime: RuntimeConfiguration | undefined): boolean {
	return (
		(runtime?.flushMode ?? "turnBased") === "turnBased" &&
		(runtime?.enableGroupedBatching ?? true) &&
		runtime?.disableBatchIdTracking !== true
	);
}

function validateOfflineRequirements(context: ValidationContext): void {
	if (!context.usesFullOfflineState) {
		return;
	}
	const { addIssue, scenario } = context;
	const runtime = scenario.document.runtime;
	if (runtime?.enableOfflineFull !== true) {
		addIssue(
			"document.runtime.enableOfflineFull",
			"Full-state or frozen loading requires offline-full support.",
		);
	}
	if (runtime?.flushMode !== "turnBased") {
		addIssue(
			"document.runtime.flushMode",
			"Writable frozen loading requires turn-based flushing.",
		);
	}
	if (runtime?.enableGroupedBatching !== true) {
		addIssue(
			"document.runtime.enableGroupedBatching",
			"Writable frozen loading requires grouped batching.",
		);
	}
	if (!isBatchIdTrackingEnabled(runtime)) {
		addIssue(
			"document.runtime.disableBatchIdTracking",
			"Writable frozen loading requires batch-id tracking, which needs turn-based flushing, grouped batching, and no disable gate.",
		);
	}
	if (
		scenario.document.dataStores.some((dataStore) => dataStore.loadingGroupId !== undefined)
	) {
		addIssue(
			"document.dataStores",
			"Full-state capture does not currently support loading-group DataStores.",
		);
	}
}

function createClientStates(
	clients: readonly ClientDefinition[],
	addIssue: AddIssue,
): Map<string, ClientValidationState> {
	validateUnique(
		clients.map((client) => client.id),
		"clients",
		"Client",
		addIssue,
	);
	return new Map(
		clients.map((definition) => [
			definition.id,
			{
				definition,
				phase: "notLoaded" as const,
				environment: "none" as const,
				inbound: "running" as const,
				outbound: "running" as const,
				connectionEpoch: 0,
				readOnly: false,
				basePosition: 0,
				cursor: 0,
				liveReference: 0,
				pending: [],
				pendingBatchIdentities: new Set<string>(),
				applied: new Map<string, number>(),
				locallyApplied: new Set<string>(),
			},
		]),
	);
}

/**
 * A container that loads at a position already holds the effect of everything sequenced up
 * to it, whether that arrived through the snapshot or through replayed saved ops.
 */
function seedAppliedFromTrace(
	context: ValidationContext,
	client: ClientValidationState,
): void {
	for (let index = 1; index <= client.cursor; index++) {
		const record = context.trace[index - 1];
		if (record?.entry.kind !== "operations") {
			continue;
		}
		if (record.entry.duplicateOf !== undefined) {
			continue;
		}
		for (const operation of record.entry.operations) {
			client.applied.set(operation, 1);
		}
	}
}

/**
 * A submitted operation takes effect locally before the service has ordered it.
 */
function applyLocally(client: ClientValidationState, operation: string): void {
	if (!client.applied.has(operation)) {
		client.applied.set(operation, 1);
	}
	client.locallyApplied.add(operation);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function validateCommand(
	context: ValidationContext,
	command: ScenarioCommand,
	path: string,
): void {
	const { addIssue } = context;
	switch (command.kind) {
		case "createDetached": {
			const client = requireClient(context, command.client, path);
			if (client !== undefined) {
				requireNotLoaded(client, path, addIssue);
				client.phase = "open";
				client.attach = "detached";
				client.connection = "disconnected";
				client.environment = "none";
			}
			break;
		}
		case "serializeContainer": {
			const client = requireOpenClient(context, command.client, path);
			if (client?.attach !== "detached" && client?.attach !== "attaching") {
				addIssue(path, "Serialization requires a detached or attaching open client.");
			}
			if (context.serializedContainers.has(command.snapshot)) {
				addIssue(path, `Serialized container '${command.snapshot}' already exists.`);
			} else if (client?.attach === "detached" || client?.attach === "attaching") {
				context.serializedContainers.set(command.snapshot, client.attach);
			}
			break;
		}
		case "beginAttach": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.attach === "detached") {
					client.attach = "attaching";
					client.connection = "disconnected";
					client.environment = "service";
				} else {
					addIssue(path, "Beginning attach requires a detached client.");
				}
			}
			break;
		}
		case "attach": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.attach === "detached") {
					markAttached(context, client);
				} else {
					addIssue(path, "Attach requires a detached client.");
				}
			}
			break;
		}
		case "completeAttach": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.attach === "attaching") {
					markAttached(context, client);
				} else {
					addIssue(path, "Completing attach requires an attaching client.");
				}
			}
			break;
		}
		case "load": {
			validateLoad(context, command.client, command.options, path);
			break;
		}
		case "connect": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.attach !== "attached" || client.environment !== "service") {
					addIssue(path, "Connect requires an attached service-backed client.");
				} else {
					beginConnection(context, client);
				}
			}
			break;
		}
		case "disconnect": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.attach === "attached") {
					client.connection = "disconnected";
					client.disconnectedAfter = context.trace.length;
				} else {
					addIssue(path, "Disconnect requires an attached client.");
				}
			}
			break;
		}
		case "close": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				client.phase = "closed";
				client.outcome = "closed";
				client.connection = "disconnected";
				client.disconnectedAfter = context.trace.length;
			}
			break;
		}
		case "createDataStore": {
			requireOpenClient(context, command.client, path);
			requireDataStore(context, command.dataStore, path);
			if (context.createdDataStores.has(command.dataStore)) {
				addIssue(path, `DataStore '${command.dataStore}' already exists.`);
			} else {
				context.createdDataStores.add(command.dataStore);
			}
			break;
		}
		case "makeDataStoreVisible": {
			requireOpenClient(context, command.client, path);
			requireDataStore(context, command.dataStore, path);
			if (context.createdDataStores.has(command.dataStore)) {
				context.visibleDataStores.add(command.dataStore);
			} else {
				addIssue(path, `DataStore '${command.dataStore}' has not been created.`);
			}
			break;
		}
		case "realizeDataStore": {
			requireOpenClient(context, command.client, path);
			requireDataStore(context, command.dataStore, path);
			if (!context.visibleDataStores.has(command.dataStore)) {
				addIssue(path, `DataStore '${command.dataStore}' is not visible.`);
			}
			break;
		}
		case "submitOperation":
		case "submitBatch":
		case "resubmitBatch": {
			validateSubmission(context, command, path);
			break;
		}
		case "concurrently": {
			for (const submission of command.submissions) {
				validateSubmission(context, submission, path);
			}
			break;
		}
		case "sequence": {
			validateSequenceEntry(context, command.entry, path);
			break;
		}
		case "deliver": {
			const target = resolvePosition(context, command.through, path, "delivery target");
			if (target !== undefined) {
				deliverTo(context, command.client, target, path);
			}
			break;
		}
		case "synchronize": {
			validateSynchronize(context, command.clients, path);
			break;
		}
		case "pauseProcessing":
		case "resumeProcessing": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				client[command.queue] = command.kind === "pauseProcessing" ? "paused" : "running";
			}
			break;
		}
		case "capturePendingState": {
			const client = requireOpenClient(context, command.client, path);
			if (client === undefined) {
				break;
			}
			if (client.attach !== "attached") {
				addIssue(path, "Pending local state capture requires an attached open client.");
			}
			recordPendingState(context, command.pendingState, path, {
				kind: "pendingLocalState",
				basePosition: client.basePosition,
				cursor: client.cursor,
				savedOps: Math.max(0, client.cursor - client.basePosition),
				stashed: [...client.pending],
			});
			break;
		}
		case "captureFullContainerState": {
			context.usesFullOfflineState = true;
			recordPendingState(context, command.pendingState, path, {
				kind: "fullContainerState",
				basePosition: 0,
				cursor: context.trace.length,
				savedOps: context.trace.length,
				stashed: [],
			});
			break;
		}
		case "requestLatestSnapshotRefresh": {
			const client = requireOpenClient(context, command.client, path);
			if (client === undefined) {
				break;
			}
			if (client.environment !== "service") {
				addIssue(path, "Latest-snapshot refresh requires service-backed storage.");
				break;
			}
			if (command.snapshot === undefined) {
				break;
			}
			const snapshot = context.snapshots.get(command.snapshot);
			if (snapshot === undefined) {
				addIssue(
					path,
					`Unknown snapshot '${command.snapshot}'. Refresh adopts an existing acknowledged snapshot; it does not produce one.`,
				);
				break;
			}
			if (snapshot.basePosition > client.cursor) {
				addIssue(
					path,
					`'${command.client}' cannot adopt snapshot '${command.snapshot}' as its base before processing the operations that snapshot already contains.`,
				);
				break;
			}
			if (client.pending.length > 0) {
				addIssue(
					path,
					`'${command.client}' has unsequenced local operations, so its base snapshot cannot be replaced.`,
				);
				break;
			}
			client.basePosition = snapshot.basePosition;
			break;
		}
		case "summarize": {
			const client = requireOpenClient(context, command.client, path);
			if (client !== undefined) {
				if (client.definition.role !== "summarizer") {
					addIssue(path, "Summary generation requires a summarizer client.");
				}
				if (client.attach !== "attached") {
					addIssue(path, "Summary generation requires an attached client.");
				}
			}
			if (context.summaries.has(command.summary)) {
				addIssue(path, `Summary '${command.summary}' already exists.`);
			} else {
				context.summaries.set(command.summary, {
					client: command.client,
					referenceCursor: client?.cursor ?? 0,
					state: "local",
				});
			}
			break;
		}
		default: {
			const exhaustiveCommand: never = command;
			return exhaustiveCommand;
		}
	}
}

/**
 * Clients whose connection lifecycle the scenario states through protocol join messages. Only
 * those clients pass through `catchingUp`; everyone else connects in one step.
 */
function collectJoiningClients(scenario: FluidScenario): ReadonlySet<string> {
	const joining = new Set<string>();
	for (const step of scenario.steps) {
		if (
			step.kind === "command" &&
			step.command.kind === "sequence" &&
			step.command.entry.kind === "join" &&
			step.command.entry.client !== undefined
		) {
			joining.add(step.command.entry.client);
		}
	}
	return joining;
}

function deferIssue(
	context: ValidationContext,
	invariant: TraceInvariant,
	path: string,
	message: string,
): void {
	const existing = context.deferred.get(invariant);
	if (existing === undefined) {
		context.deferred.set(invariant, [{ path, message }]);
	} else {
		existing.push({ path, message });
	}
}

/**
 * A client that states its join explicitly is only connected once that join is ordered and
 * processed; otherwise obtaining a connection is a single step.
 */
function beginConnection(context: ValidationContext, client: ClientValidationState): void {
	client.connection = context.joiningClients.has(client.definition.id)
		? "catchingUp"
		: "connected";
	client.connectionEpoch += 1;
	client.connectionMode = "write";
	delete client.lastClientSequence;
}

function markAttached(context: ValidationContext, client: ClientValidationState): void {
	client.attach = "attached";
	client.environment = "service";
	beginConnection(context, client);
}

function validateLoad(
	context: ValidationContext,
	clientId: string,
	options: LoadOptions,
	path: string,
): void {
	const { addIssue } = context;
	const client = requireClient(context, clientId, path);
	if (client === undefined) {
		return;
	}
	requireNotLoaded(client, path, addIssue);
	const source = options.from;
	if (source.kind === "service") {
		const snapshot =
			source.snapshot === undefined ? undefined : context.snapshots.get(source.snapshot);
		if (source.snapshot !== undefined && snapshot === undefined) {
			addIssue(path, `Unknown service snapshot '${source.snapshot}'.`);
		}
		client.attach = "attached";
		client.environment = "service";
		client.readOnly = false;
		client.basePosition = snapshot?.basePosition ?? 0;
		client.cursor = client.basePosition;
		if (options.deltaConnection !== undefined) {
			client.connection = "disconnected";
			client.disconnectedAfter = context.trace.length;
		} else {
			beginConnection(context, client);
		}
		client.connectionMode = options.requestedConnectionMode ?? "write";
		client.liveReference = client.basePosition;
		seedAppliedFromTrace(context, client);
	} else if (source.kind === "pendingState") {
		const captured = context.pendingStates.get(source.pendingState);
		if (captured === undefined) {
			addIssue(path, `Unknown pending state '${source.pendingState}'.`);
		} else {
			if (source.mode === "frozen" && captured.kind !== "fullContainerState") {
				addIssue(path, "Frozen loading requires captureFullContainerState output.");
			}
			client.basePosition = captured.basePosition;
			client.cursor = captured.cursor;
			client.pending = [...captured.stashed];
			for (const operation of captured.stashed) {
				context.submissionReference.set(operation, captured.cursor);
				context.replayedOperations.add(operation);
			}
		}
		if (source.mode === "frozen") {
			context.usesFullOfflineState = true;
		}
		client.attach = "attached";
		client.environment = source.mode === "frozen" ? "frozen" : "service";
		beginConnection(context, client);
		client.readOnly = source.readOnly ?? false;
		client.liveReference = client.cursor;
		seedAppliedFromTrace(context, client);
		for (const operation of client.pending) {
			applyLocally(client, operation);
		}
	} else {
		const serializedAttachState = context.serializedContainers.get(source.snapshot);
		if (serializedAttachState === undefined) {
			addIssue(path, `Unknown serialized container '${source.snapshot}'.`);
		}
		client.attach = serializedAttachState === "attaching" ? "attached" : "detached";
		client.connection = "disconnected";
		client.environment = serializedAttachState === "attaching" ? "service" : "none";
		client.readOnly = false;
	}
	if (options.pauseAt !== undefined) {
		const pinned = resolvePosition(context, options.pauseAt, path, "pause position");
		if (pinned !== undefined) {
			if (pinned < client.cursor) {
				addIssue(
					path,
					`Pause position '${options.pauseAt}' precedes the position this container loads at.`,
				);
			}
			client.pinnedAt = pinned;
		}
	}
	client.phase = "open";
}

function validateSubmission(
	context: ValidationContext,
	command: SubmissionCommand,
	path: string,
): void {
	const { addIssue } = context;
	const client = requireSubmittableClient(context, command.client, path);
	if (command.kind === "submitOperation") {
		declareOperation(context, client, command.operation, undefined, path);
		return;
	}
	if (command.kind === "submitBatch") {
		if (context.batches.has(command.batch.id)) {
			addIssue(
				path,
				`Batch '${command.batch.id}' already exists. Use resubmitBatch to replay it.`,
			);
			return;
		}
		if (command.batch.operations.length === 0) {
			addIssue(path, "A submitted batch must contain at least one operation.");
		}
		context.batches.set(command.batch.id, {
			id: command.batch.id,
			definition: command.batch,
			entries: [],
			submissions: 1,
		});
		for (const operation of command.batch.operations) {
			declareOperation(context, client, operation, command.batch.id, path);
		}
		return;
	}

	const batch = context.batches.get(command.batch);
	if (batch === undefined) {
		addIssue(path, `Unknown batch '${command.batch}'. Only a declared batch can be replayed.`);
		return;
	}
	batch.submissions += 1;
	if (client === undefined) {
		return;
	}
	if (command.batchId !== undefined) {
		client.pendingBatchIdentities.add(command.batchId);
	}
	for (const operation of batch.definition.operations) {
		if (context.sequencedOperations.has(operation.id) && command.batchId === undefined) {
			addIssue(
				path,
				`Batch '${command.batch}' was already sequenced; a replay must carry the original batch identity so a peer can reject the repeat.`,
			);
		}
		if (!client.pending.includes(operation.id)) {
			client.pending.push(operation.id);
		}
		context.submissionReference.set(operation.id, client.cursor);
		applyLocally(client, operation.id);
	}
}

function declareOperation(
	context: ValidationContext,
	client: ClientValidationState | undefined,
	operation: { readonly id: string; readonly dataStore: string },
	batch: string | undefined,
	path: string,
): void {
	const { addIssue } = context;
	requireDataStore(context, operation.dataStore, path);
	if (!context.visibleDataStores.has(operation.dataStore)) {
		addIssue(path, `DataStore '${operation.dataStore}' is not visible.`);
	}
	if (context.operations.has(operation.id)) {
		addIssue(
			path,
			`Operation '${operation.id}' already exists. A logical operation has one identity; replay it with resubmitBatch.`,
		);
		return;
	}
	context.operations.set(operation.id, {
		id: operation.id,
		dataStore: operation.dataStore,
		...(batch === undefined ? {} : { batch }),
	});
	if (client !== undefined) {
		client.pending.push(operation.id);
		context.submissionReference.set(operation.id, client.cursor);
		applyLocally(client, operation.id);
	}
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

function validateSequenceEntry(
	context: ValidationContext,
	entry: TraceEntry,
	path: string,
): void {
	if (reservedSequenceRefs.includes(entry.at)) {
		deferIssue(
			context,
			"denseTotalOrder",
			path,
			`'${entry.at}' is a reserved sequence reference and cannot name an entry.`,
		);
		return;
	}
	if (context.positions.has(entry.at)) {
		deferIssue(
			context,
			"denseTotalOrder",
			path,
			`Sequence position '${entry.at}' is declared more than once.`,
		);
		return;
	}

	const index = context.trace.length + 1;
	const submitter =
		entry.kind === "summaryAck" || entry.kind === "summaryNack" ? undefined : entry.client;

	if (submitter !== undefined && (entry.kind === "operations" || entry.kind === "summarize")) {
		// Protocol messages have their own preconditions: a join is ordered while the client is
		// still catching up, and a leave is ordered after it lost its connection.
		requireSequencingClient(context, submitter, path);
	}

	const defaultReference = defaultReferenceFor(context, entry);
	const referenceIndex =
		entry.referenceSequence === undefined
			? defaultReference
			: (resolvePosition(context, entry.referenceSequence, path, "reference sequence") ??
				defaultReference);

	if (referenceIndex >= index) {
		deferIssue(
			context,
			"causalReferenceSequence",
			path,
			`Reference sequence for '${entry.at}' must precede its own position in the total order.`,
		);
	}
	if (entry.referenceSequence !== undefined && referenceIndex > defaultReference) {
		deferIssue(
			context,
			"causalReferenceSequence",
			path,
			`Reference sequence '${entry.referenceSequence}' is ahead of what '${submitter ?? "the submitter"}' had processed when it produced '${entry.at}'.`,
		);
	}

	const previousMinimum = context.trace[context.trace.length - 1]?.minimumIndex ?? 0;
	const minimumIndex =
		entry.minimumSequence === undefined
			? previousMinimum
			: (resolvePosition(context, entry.minimumSequence, path, "minimum sequence") ??
				previousMinimum);
	if (minimumIndex < previousMinimum) {
		deferIssue(
			context,
			"minimumSequenceMonotonic",
			path,
			`Minimum sequence number moved backwards at '${entry.at}'.`,
		);
	}
	if (minimumIndex > referenceIndex) {
		deferIssue(
			context,
			"minimumSequenceMonotonic",
			path,
			`Minimum sequence number at '${entry.at}' passes the reference sequence number of a live submitter.`,
		);
	}
	const submitterState = submitter === undefined ? undefined : context.clients.get(submitter);
	if (submitterState !== undefined && entry.kind !== "leave") {
		submitterState.liveReference = referenceIndex;
	}
	const liveFloor = leastLiveReference(context);
	if (liveFloor !== undefined && minimumIndex > liveFloor) {
		deferIssue(
			context,
			"minimumSequenceMonotonic",
			path,
			`Minimum sequence number at '${entry.at}' passes the least reference position among live clients.`,
		);
	}

	if (submitterState !== undefined && entry.clientSequence !== undefined) {
		if (
			submitterState.lastClientSequence !== undefined &&
			entry.clientSequence <= submitterState.lastClientSequence
		) {
			deferIssue(
				context,
				"clientSequenceMonotonic",
				path,
				`Client sequence number ${entry.clientSequence} at '${entry.at}' does not advance within '${submitter}' current connection.`,
			);
		}
		submitterState.lastClientSequence = entry.clientSequence;
	}

	let effectiveBatchId: string | undefined;
	let explicitBatchId = false;
	switch (entry.kind) {
		case "operations": {
			const identity = validateOperationsEntry(context, entry, index, path);
			effectiveBatchId = identity.effectiveBatchId;
			explicitBatchId = identity.explicit;
			break;
		}
		case "summarize": {
			validateSummarizeEntry(context, entry.summary, entry.client, index, path);
			break;
		}
		case "summaryAck":
		case "summaryNack": {
			validateSummaryOutcomeEntry(context, entry, path);
			break;
		}
		case "join": {
			validateJoinEntry(context, entry.client, index, path);
			break;
		}
		case "leave": {
			validateLeaveEntry(context, entry.client, path);
			break;
		}
		default: {
			// A noop may be service-generated, so it needs no client.
			break;
		}
	}

	context.positions.set(entry.at, index);
	context.trace.push({
		entry,
		index,
		path,
		referenceIndex,
		minimumIndex,
		epoch: submitterState?.connectionEpoch ?? 0,
		maxReference: defaultReference,
		explicitBatchId,
		...(effectiveBatchId === undefined ? {} : { effectiveBatchId }),
	});
}

function defaultReferenceFor(context: ValidationContext, entry: TraceEntry): number {
	if (entry.kind === "summarize") {
		return context.summaries.get(entry.summary)?.referenceCursor ?? 0;
	}
	if (entry.kind === "operations") {
		const references = entry.operations
			.map((operation) => context.submissionReference.get(operation))
			.filter((value): value is number => value !== undefined);
		if (references.length > 0) {
			return Math.min(...references);
		}
		if (entry.batch !== undefined) {
			const batch = context.batches.get(entry.batch);
			const batchReferences = (batch?.definition.operations ?? [])
				.map((operation) => context.submissionReference.get(operation.id))
				.filter((value): value is number => value !== undefined);
			if (batchReferences.length > 0) {
				return Math.min(...batchReferences);
			}
		}
	}
	const client =
		entry.kind === "summaryAck" || entry.kind === "summaryNack" ? undefined : entry.client;
	return client === undefined
		? context.trace.length
		: (context.clients.get(client)?.cursor ?? 0);
}

function validateOperationsEntry(
	context: ValidationContext,
	entry: OperationsTraceEntry,
	index: number,
	path: string,
): { readonly effectiveBatchId: string | undefined; readonly explicit: boolean } {
	const { addIssue } = context;
	const runtime = context.scenario.document.runtime;
	const chunk = entry.virtualization?.chunk;

	if (chunk !== undefined) {
		if (runtime?.chunkSizeInBytes === undefined) {
			addIssue(path, "Chunked wire messages require a configured chunk size.");
		}
		if (chunk.count < 2) {
			addIssue(path, "A chunked payload spans at least two wire messages.");
		}
		if (chunk.index < 1 || chunk.index > chunk.count) {
			addIssue(path, `Chunk index ${chunk.index} is outside 1..${chunk.count}.`);
		}
		if (chunk.index < chunk.count && entry.operations.length > 0) {
			deferIssue(
				context,
				"wireReconstruction",
				path,
				`Chunk ${chunk.index} of ${chunk.count} reconstructs nothing; only the final chunk carries operations.`,
			);
		}
		if (chunk.index === chunk.count && entry.operations.length === 0) {
			deferIssue(
				context,
				"wireReconstruction",
				path,
				"The final chunk must reconstruct the payload it completes.",
			);
		}
		if (entry.batch === undefined) {
			addIssue(path, "A chunked wire message must name the batch it belongs to.");
		}
	} else if (entry.operations.length === 0) {
		addIssue(path, "An operations entry must carry at least one logical operation.");
	}

	if (entry.operations.length > 1 && entry.virtualization?.grouped !== true) {
		addIssue(
			path,
			`'${entry.at}' carries ${entry.operations.length} logical operations, but an ungrouped wire message carries exactly one.`,
		);
	}
	if (entry.virtualization?.grouped === true && runtime?.enableGroupedBatching !== true) {
		addIssue(path, "A grouped wire message requires grouped batching.");
	}
	if (entry.virtualization?.compressed === true && runtime?.compression === undefined) {
		addIssue(path, "A compressed wire message requires compression to be configured.");
	}

	const batch = entry.batch === undefined ? undefined : context.batches.get(entry.batch);
	if (entry.batch !== undefined && batch === undefined) {
		addIssue(path, `Unknown batch '${entry.batch}'.`);
	}
	batch?.entries.push(index);

	const duplicate = validateDuplicateReference(context, entry, path);
	const client = context.clients.get(entry.client);

	for (const operation of entry.operations) {
		if (!context.operations.has(operation)) {
			addIssue(path, `Unknown operation '${operation}'.`);
			continue;
		}
		if (duplicate) {
			// The replay was answered by rejection, so it no longer awaits an acknowledgement.
			const outstanding = client?.pending.indexOf(operation) ?? -1;
			if (client !== undefined && outstanding !== -1) {
				client.pending.splice(outstanding, 1);
			}
			continue;
		}
		if (client !== undefined) {
			const position = client.pending.indexOf(operation);
			if (position === -1) {
				addIssue(
					path,
					`'${entry.client}' has no outstanding submission of operation '${operation}'.`,
				);
			} else {
				client.pending.splice(position, 1);
			}
		}
		if (context.sequencedOperations.has(operation)) {
			deferIssue(
				context,
				"exactlyOnceApplication",
				path,
				`Operation '${operation}' is already sequenced. A repeat must be marked as a duplicate of the earlier entry.`,
			);
		} else {
			context.sequencedOperations.set(operation, index);
		}
	}

	const explicit = entry.batchId !== undefined;
	const derived =
		entry.clientSequence === undefined
			? undefined
			: `${entry.client}_[${entry.clientSequence}]`;
	const effectiveBatchId = entry.batchId ?? derived;
	const trackingEnabled = isBatchIdTrackingEnabled(context.scenario.document.runtime);
	if (explicit && !trackingEnabled) {
		addIssue(path, "An explicit batch identity requires batch-id tracking.");
	}
	if (
		!explicit &&
		trackingEnabled &&
		!duplicate &&
		entry.operations.some((operation) => context.replayedOperations.has(operation))
	) {
		deferIssue(
			context,
			"exactlyOnceApplication",
			path,
			`'${entry.at}' replays operations rehydrated from captured pending state under a new client identity, so it must carry the original batch id.`,
		);
	}
	if (effectiveBatchId !== undefined && !duplicate) {
		const owner = context.batchIdOwners.get(effectiveBatchId);
		if (owner !== undefined) {
			deferIssue(
				context,
				"exactlyOnceApplication",
				path,
				`Batch identity '${effectiveBatchId}' was already sequenced; '${entry.at}' must declare itself a duplicate of that entry.`,
			);
		} else {
			context.batchIdOwners.set(effectiveBatchId, index);
		}
		client?.pendingBatchIdentities.delete(effectiveBatchId);
	}

	return { effectiveBatchId, explicit };
}

function validateDuplicateReference(
	context: ValidationContext,
	entry: OperationsTraceEntry,
	path: string,
): boolean {
	if (entry.duplicateOf === undefined) {
		return false;
	}
	const { addIssue } = context;
	const originalIndex = context.positions.get(entry.duplicateOf);
	if (originalIndex === undefined) {
		addIssue(path, `Unknown sequence position '${entry.duplicateOf}'.`);
		return true;
	}
	const original = context.trace[originalIndex - 1];
	if (original?.entry.kind !== "operations") {
		addIssue(path, `'${entry.duplicateOf}' does not carry operations.`);
		return true;
	}
	const originalOperations = new Set(original.entry.operations);
	if (
		entry.operations.length !== original.entry.operations.length ||
		entry.operations.some((operation) => !originalOperations.has(operation))
	) {
		addIssue(
			path,
			`'${entry.at}' claims to duplicate '${entry.duplicateOf}' but carries different logical operations.`,
		);
	}
	const replayIdentity =
		entry.batchId ??
		(entry.clientSequence === undefined
			? undefined
			: `${entry.client}_[${entry.clientSequence}]`);
	if (replayIdentity === undefined || replayIdentity !== original.effectiveBatchId) {
		deferIssue(
			context,
			"exactlyOnceApplication",
			path,
			`Duplicate detection requires '${entry.at}' to carry the batch identity of '${entry.duplicateOf}'; a replay under a new client identity must preserve the original batch id.`,
		);
	} else if (!original.explicitBatchId && entry.batchId === undefined) {
		deferIssue(
			context,
			"exactlyOnceApplication",
			path,
			`Neither '${entry.duplicateOf}' nor '${entry.at}' carries an explicit batch id, so a peer could not reject the repeat.`,
		);
	}
	return true;
}

/**
 * The least reference position pinned by a live write client. The collaboration window cannot
 * pass it, because that client may still rebase against everything after it.
 */
function leastLiveReference(context: ValidationContext): number | undefined {
	let least: number | undefined;
	for (const client of context.clients.values()) {
		if (client.phase !== "open" || client.environment !== "service") {
			continue;
		}
		if (client.connectionMode === "read") {
			continue;
		}
		const connectedWriter =
			client.connection === "connected" || client.connection === "catchingUp";
		if (!connectedWriter && client.joinedAt === undefined) {
			continue;
		}
		least = least === undefined ? client.liveReference : Math.min(least, client.liveReference);
	}
	return least;
}

function validateJoinEntry(
	context: ValidationContext,
	clientId: string | undefined,
	index: number,
	path: string,
): void {
	if (clientId === undefined) {
		context.addIssue(path, "A 'join' entry must name the client that is joining.");
		return;
	}
	const client = requireOpenClient(context, clientId, path);
	if (client === undefined) {
		return;
	}
	if (client.attach !== "attached" || client.environment !== "service") {
		context.addIssue(
			path,
			`'${clientId}' is not attached to a service-backed document, so it cannot join.`,
		);
		return;
	}
	if (client.joinedAt !== undefined) {
		context.addIssue(
			path,
			`'${clientId}' has a previous membership that no leave message has retired; a reconnecting client waits for its own leave before it is live again.`,
		);
		return;
	}
	if (client.connection !== "catchingUp") {
		context.addIssue(
			path,
			`'${clientId}' is not establishing a connection, so its join cannot be sequenced.`,
		);
		return;
	}
	client.joinedAt = index;
	if (client.inbound === "running") {
		// Catching up means processing everything ordered before the join point.
		applyThrough(client, context, Math.min(index, client.pinnedAt ?? index));
	}
	client.liveReference = client.cursor;
	refreshConnectionState(client);
}

function validateLeaveEntry(
	context: ValidationContext,
	clientId: string | undefined,
	path: string,
): void {
	if (clientId === undefined) {
		context.addIssue(path, "A 'leave' entry must name the client that is leaving.");
		return;
	}
	const client = context.clients.get(clientId);
	if (client === undefined) {
		context.addIssue(path, `Unknown client '${clientId}'.`);
		return;
	}
	if (client.joinedAt === undefined) {
		context.addIssue(path, `'${clientId}' is not a live member, so it cannot leave.`);
		return;
	}
	if (client.connection === "connected") {
		context.addIssue(
			path,
			`'${clientId}' still holds its connection; a leave message follows the loss of that connection.`,
		);
		return;
	}
	delete client.joinedAt;
}

/**
 * A catching-up client becomes connected once it has processed its own join message.
 */
function refreshConnectionState(client: ClientValidationState): void {
	if (
		client.connection === "catchingUp" &&
		client.joinedAt !== undefined &&
		client.cursor >= client.joinedAt
	) {
		client.connection = "connected";
	}
}

function validateSummarizeEntry(
	context: ValidationContext,
	summary: string,
	client: string,
	index: number,
	path: string,
): void {
	const { addIssue } = context;
	const record = context.summaries.get(summary);
	if (record === undefined) {
		addIssue(path, `Unknown summary '${summary}'. Generate it before it is sequenced.`);
		return;
	}
	if (record.sequencedAt !== undefined) {
		addIssue(path, `Summary '${summary}' has already been broadcast.`);
		return;
	}
	if (record.client !== client) {
		addIssue(
			path,
			`Summary '${summary}' was generated by '${record.client}', not '${client}'.`,
		);
	}
	record.sequencedAt = index;
	record.state = "broadcast";
}

function validateSummaryOutcomeEntry(
	context: ValidationContext,
	entry: Extract<TraceEntry, { kind: "summaryAck" | "summaryNack" }>,
	path: string,
): void {
	const { addIssue } = context;
	const record = context.summaries.get(entry.summary);
	if (record === undefined) {
		addIssue(path, `Unknown summary '${entry.summary}'.`);
		return;
	}
	if (record.sequencedAt === undefined) {
		addIssue(
			path,
			`Summary '${entry.summary}' has no sequenced summary op to acknowledge. An ack names the position of the summary op it answers.`,
		);
		return;
	}
	if (record.state === "acked" || record.state === "nacked") {
		addIssue(path, `Summary '${entry.summary}' already has an outcome.`);
		return;
	}
	if (entry.kind === "summaryAck") {
		record.state = "acked";
		if (context.snapshots.has(entry.snapshot)) {
			addIssue(path, `Snapshot '${entry.snapshot}' already exists.`);
		} else {
			const summarizeEntry = context.trace[record.sequencedAt - 1];
			context.snapshots.set(entry.snapshot, {
				basePosition: summarizeEntry?.referenceIndex ?? 0,
			});
		}
	} else {
		record.state = "nacked";
	}
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

function deliverTo(
	context: ValidationContext,
	clientId: string,
	target: number,
	path: string,
): void {
	const client = requireOpenClient(context, clientId, path);
	if (client === undefined) {
		return;
	}
	const rejection = deliveryRejection(client, target);
	context.deliveries.push({
		client: clientId,
		from: client.cursor,
		to: target,
		path,
		...(rejection === undefined ? {} : { rejection }),
	});
	if (rejection !== undefined) {
		deferIssue(context, "orderedDelivery", path, rejection);
		return;
	}
	applyThrough(client, context, target);
}

function deliveryRejection(client: ClientValidationState, target: number): string | undefined {
	const id = client.definition.id;
	if (client.environment === "frozen") {
		return `'${id}' is loaded frozen and has no live op stream to deliver.`;
	}
	if (client.connection !== "connected" && client.connection !== "catchingUp") {
		return `'${id}' is not connected and cannot process sequenced messages.`;
	}
	if (client.inbound === "paused") {
		return `'${id}' has a paused inbound queue and cannot process messages.`;
	}
	if (target < client.cursor) {
		return `'${id}' cannot move its processing position backwards.`;
	}
	if (client.pinnedAt !== undefined && target > client.pinnedAt) {
		return `'${id}' was loaded paused and cannot process past its pinned position.`;
	}
	return undefined;
}

function applyThrough(
	client: ClientValidationState,
	context: ValidationContext,
	target: number,
): void {
	for (let index = client.cursor + 1; index <= target; index++) {
		const record = context.trace[index - 1];
		if (record?.entry.kind !== "operations") {
			continue;
		}
		if (
			record.entry.client !== client.definition.id &&
			record.effectiveBatchId !== undefined &&
			client.pendingBatchIdentities.has(record.effectiveBatchId)
		) {
			// The same logical batch exists under another client identity. The container closes
			// before applying it, which is what keeps the operation applied exactly once.
			client.cursor = index - 1;
			client.phase = "closed";
			client.outcome = "forkedContainer";
			client.connection = "disconnected";
			client.disconnectedAfter = context.trace.length;
			return;
		}
		if (record.entry.duplicateOf !== undefined) {
			continue;
		}
		const ownSubmission = record.entry.client === client.definition.id;
		for (const operation of record.entry.operations) {
			if (ownSubmission && client.locallyApplied.has(operation)) {
				// Processing the local echo of an already applied operation acknowledges it.
				client.locallyApplied.delete(operation);
				continue;
			}
			client.applied.set(operation, (client.applied.get(operation) ?? 0) + 1);
		}
	}
	client.cursor = target;
	refreshConnectionState(client);
}

function validateSynchronize(
	context: ValidationContext,
	clients: readonly string[],
	path: string,
): void {
	const target = context.trace.length;
	if (clients.length > 0) {
		for (const clientId of clients) {
			deliverTo(context, clientId, target, path);
		}
		return;
	}
	for (const [, client] of context.clients) {
		if (
			client.phase === "open" &&
			client.connection === "connected" &&
			client.environment === "service" &&
			client.inbound === "running" &&
			(client.pinnedAt === undefined || client.pinnedAt >= target)
		) {
			applyThrough(client, context, target);
		}
	}
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

function validateExpectation(
	context: ValidationContext,
	expectation: ScenarioExpectation,
	path: string,
): void {
	const { addIssue } = context;
	switch (expectation.kind) {
		case "clientState": {
			validateClientStateExpectation(context, expectation, path);
			break;
		}
		case "operation": {
			validateOperationExpectation(context, expectation, path);
			break;
		}
		case "logicalApplication": {
			const client = requireKnownClient(context, expectation.client, path);
			if (!context.operations.has(expectation.operation)) {
				addIssue(path, `Unknown operation '${expectation.operation}'.`);
				break;
			}
			const actual = client?.applied.get(expectation.operation) ?? 0;
			if (client !== undefined && actual !== expectation.times) {
				addIssue(
					path,
					`'${expectation.client}' applied '${expectation.operation}' ${actual} time(s); the scenario expects ${expectation.times}.`,
				);
			}
			break;
		}
		case "batchVirtualization": {
			validateBatchVirtualizationExpectation(context, expectation, path);
			break;
		}
		case "operationBunches": {
			validateOperationBunchExpectation(context, expectation, path);
			break;
		}
		case "pendingReplay": {
			validatePendingReplayExpectation(context, expectation, path);
			break;
		}
		case "pendingState": {
			validatePendingStateExpectation(context, expectation, path);
			break;
		}
		case "summary": {
			const record = context.summaries.get(expectation.summary);
			if (record === undefined) {
				addIssue(path, `Unknown summary '${expectation.summary}'.`);
				break;
			}
			if (record.state !== expectation.state) {
				addIssue(
					path,
					`Summary '${expectation.summary}' is '${record.state}' in the declared trace, not '${expectation.state}'.`,
				);
			}
			for (const dataStore of Object.keys(expectation.dataStores ?? {})) {
				if (!context.dataStores.has(dataStore)) {
					addIssue(path, `Unknown DataStore '${dataStore}'.`);
				}
			}
			break;
		}
		case "dataStore": {
			const client = requireKnownClient(context, expectation.client, path);
			if (!context.dataStores.has(expectation.dataStore)) {
				addIssue(path, `Unknown DataStore '${expectation.dataStore}'.`);
			}
			for (const operation of expectation.containsOperations ?? []) {
				const record = context.operations.get(operation);
				if (record === undefined) {
					addIssue(path, `Unknown operation '${operation}'.`);
					continue;
				}
				if (record.dataStore !== expectation.dataStore) {
					addIssue(
						path,
						`Operation '${operation}' targets DataStore '${record.dataStore}', not '${expectation.dataStore}'.`,
					);
				}
				if (client !== undefined && (client.applied.get(operation) ?? 0) === 0) {
					addIssue(
						path,
						`'${expectation.client}' has not processed operation '${operation}'.`,
					);
				}
			}
			break;
		}
		case "snapshotFetch": {
			requireKnownClient(context, expectation.client, path);
			if (expectation.snapshot !== undefined && !context.snapshots.has(expectation.snapshot)) {
				addIssue(path, `Unknown snapshot '${expectation.snapshot}'.`);
			}
			if (
				expectation.loadingGroupId !== undefined &&
				![...context.dataStores.values()].some(
					(dataStore) => dataStore.loadingGroupId === expectation.loadingGroupId,
				)
			) {
				addIssue(path, `Unknown loading group '${expectation.loadingGroupId}'.`);
			}
			break;
		}
		case "delivery": {
			validateDeliveryExpectation(context, expectation, path);
			break;
		}
		case "sequenceOrder": {
			const before = resolvePosition(context, expectation.before, path, "position");
			const after = resolvePosition(context, expectation.after, path, "position");
			if (before !== undefined && after !== undefined && before >= after) {
				addIssue(
					path,
					`'${expectation.before}' does not precede '${expectation.after}' in the declared total order.`,
				);
			}
			break;
		}
		case "convergence": {
			validateConvergenceExpectation(context, expectation.clients, path);
			break;
		}
		case "traceInvariants": {
			for (const invariant of expectation.invariants) {
				if (!allTraceInvariants.includes(invariant)) {
					addIssue(path, `Unknown trace invariant '${invariant}'.`);
				}
			}
			checkTraceInvariants(context, expectation.invariants, path);
			break;
		}
		default: {
			const exhaustiveExpectation: never = expectation;
			return exhaustiveExpectation;
		}
	}
}

function validateOperationExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "operation" }>,
	path: string,
): void {
	const { addIssue } = context;
	const client = requireKnownClient(context, expectation.client, path);
	if (!context.operations.has(expectation.operation)) {
		addIssue(path, `Unknown operation '${expectation.operation}'.`);
		return;
	}
	if (client === undefined) {
		return;
	}
	const actual = operationStateFor(context, client, expectation.operation);
	if (actual === expectation.state) {
		return;
	}

	switch (expectation.state) {
		case "pending": {
			addIssue(
				path,
				`'${expectation.client}' has no outstanding submission of '${expectation.operation}'; its state is '${actual}'.`,
			);
			break;
		}
		case "sequenced": {
			if (context.sequencedOperations.get(expectation.operation) === undefined) {
				addIssue(
					path,
					`Operation '${expectation.operation}' has no position in the total order.`,
				);
			} else {
				addIssue(
					path,
					`'${expectation.client}' observes '${expectation.operation}' as '${actual}', not 'sequenced'.`,
				);
			}
			break;
		}
		case "processed": {
			addIssue(
				path,
				`'${expectation.client}' has not processed '${expectation.operation}'; its state is '${actual}'.`,
			);
			break;
		}
		case "acked": {
			const sequencedIndex = context.sequencedOperations.get(expectation.operation);
			const record =
				sequencedIndex === undefined ? undefined : context.trace[sequencedIndex - 1];
			const submitter = record?.entry.kind === "operations" ? record.entry.client : undefined;
			if (submitter !== expectation.client) {
				addIssue(
					path,
					`'${expectation.operation}' was sequenced from '${submitter ?? "another client"}', so '${expectation.client}' observes it as processed, not acked.`,
				);
			} else {
				addIssue(
					path,
					`'${expectation.client}' has not processed its own sequenced '${expectation.operation}'; its state is '${actual}'.`,
				);
			}
			break;
		}
		case "notProcessed": {
			addIssue(
				path,
				`'${expectation.client}' observes '${expectation.operation}' as '${actual}', not 'notProcessed'.`,
			);
			break;
		}
		default: {
			const exhaustiveState: never = expectation.state;
			return exhaustiveState;
		}
	}
}

function operationStateFor(
	context: ValidationContext,
	client: ClientValidationState,
	operation: string,
): OperationDeliveryState {
	if (client.pending.includes(operation)) {
		return "pending";
	}
	const sequencedAt = context.sequencedOperations.get(operation);
	if (sequencedAt === undefined) {
		return "notProcessed";
	}
	if (client.cursor < sequencedAt) {
		return "sequenced";
	}
	const record = context.trace[sequencedAt - 1];
	if (
		record?.entry.kind === "operations" &&
		record.entry.client === client.definition.id &&
		!client.locallyApplied.has(operation)
	) {
		return "acked";
	}
	return (client.applied.get(operation) ?? 0) > 0 ? "processed" : "notProcessed";
}

/**
 * The replay queue is the client's outstanding submissions collapsed to their batches, in
 * submission order. That is what `PendingStateManager` preserves across a reconnect.
 */
function validatePendingReplayExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "pendingReplay" }>,
	path: string,
): void {
	const { addIssue } = context;
	const client = requireKnownClient(context, expectation.client, path);
	for (const batch of [...expectation.batches, ...(expectation.rebasedBatches ?? [])]) {
		if (!context.batches.has(batch)) {
			addIssue(path, `Unknown batch '${batch}'.`);
		}
	}
	for (const batch of expectation.rebasedBatches ?? []) {
		if (!expectation.batches.includes(batch)) {
			addIssue(path, `Rebased batch '${batch}' is not part of the replayed sequence.`);
		}
	}
	if (client === undefined) {
		return;
	}
	const unbatched = client.pending.filter(
		(operation) => context.operations.get(operation)?.batch === undefined,
	);
	if (unbatched.length > 0) {
		addIssue(
			path,
			`'${expectation.client}' has unbatched pending operations [${unbatched.join(", ")}]; this expectation currently describes named batches only.`,
		);
	}
	const actual: string[] = [];
	for (const operation of client.pending) {
		const batch = context.operations.get(operation)?.batch;
		if (batch === undefined || actual[actual.length - 1] === batch) {
			continue;
		}
		actual.push(batch);
	}
	if (
		actual.length !== expectation.batches.length ||
		actual.some((batch, position) => batch !== expectation.batches[position])
	) {
		addIssue(
			path,
			`'${expectation.client}' will replay [${actual.join(", ")}], not [${expectation.batches.join(", ")}].`,
		);
	}
}

function validateClientStateExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "clientState" }>,
	path: string,
): void {
	const client = requireKnownClient(context, expectation.client, path);
	if (client === undefined) {
		return;
	}
	const actual = {
		attach: client.attach,
		connection: client.connection,
		connectionMode: client.connectionMode,
		readonly: client.readOnly,
		environment: client.environment,
		dirty: client.pending.length > 0 ? ("dirty" as const) : ("saved" as const),
		closed: client.phase === "closed",
		outcome: client.outcome,
		inbound: client.inbound,
		outbound: client.outbound,
	};
	for (const [key, expected] of Object.entries(expectation.state)) {
		if (expected === undefined) {
			continue;
		}
		const observed = actual[key as keyof typeof actual];
		if (observed !== expected) {
			context.addIssue(
				path,
				`'${expectation.client}' has ${key} '${String(observed)}' in the declared timeline, not '${String(expected)}'.`,
			);
		}
	}
}

/**
 * A new bunch begins whenever the target DataStore changes inside one sequenced message.
 */
function validateOperationBunchExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "operationBunches" }>,
	path: string,
): void {
	const { addIssue } = context;
	const index = resolvePosition(context, expectation.at, path, "position");
	if (index === undefined) {
		return;
	}
	const record = context.trace[index - 1];
	if (record?.entry.kind !== "operations") {
		addIssue(path, `'${expectation.at}' does not carry operations.`);
		return;
	}
	const actual: { dataStore: string; operations: string[] }[] = [];
	for (const operation of record.entry.operations) {
		const dataStore = context.operations.get(operation)?.dataStore;
		if (dataStore === undefined) {
			addIssue(path, `Unknown operation '${operation}'.`);
			return;
		}
		const current = actual[actual.length - 1];
		if (current?.dataStore === dataStore) {
			current.operations.push(operation);
		} else {
			actual.push({ dataStore, operations: [operation] });
		}
	}
	const describe = (
		bunches: readonly { dataStore: string; operations: readonly string[] }[],
	) => bunches.map((bunch) => `${bunch.dataStore}x${bunch.operations.length}`).join(", ");
	const matches =
		actual.length === expectation.bunches.length &&
		actual.every((bunch, position) => {
			const expected = expectation.bunches[position];
			return (
				expected?.dataStore === bunch.dataStore &&
				expected.operations.length === bunch.operations.length &&
				expected.operations.every(
					(operation, offset) => operation === bunch.operations[offset],
				)
			);
		});
	if (!matches) {
		addIssue(
			path,
			`'${expectation.at}' dispatches as [${describe(actual)}], not [${describe(expectation.bunches)}].`,
		);
	}
}

function validateBatchVirtualizationExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "batchVirtualization" }>,
	path: string,
): void {
	const { addIssue } = context;
	const batch = context.batches.get(expectation.batch);
	if (batch === undefined) {
		addIssue(path, `Unknown batch '${expectation.batch}'.`);
		return;
	}
	const records = batch.entries
		.map((index) => context.trace[index - 1])
		.filter(
			(record): record is TraceRecord =>
				record?.entry.kind === "operations" && record.entry.duplicateOf === undefined,
		);
	if (records.length === 0) {
		addIssue(
			path,
			`Batch '${expectation.batch}' has no sequenced wire messages, so its virtualization is not observable.`,
		);
		return;
	}
	const grouped = records.some(
		(record) =>
			record.entry.kind === "operations" && record.entry.virtualization?.grouped === true,
	);
	const compressed = records.some(
		(record) =>
			record.entry.kind === "operations" && record.entry.virtualization?.compressed === true,
	);
	const chunked = records.some(
		(record) =>
			record.entry.kind === "operations" && record.entry.virtualization?.chunk !== undefined,
	);
	if (grouped !== expectation.grouped) {
		addIssue(path, `Batch '${expectation.batch}' grouped=${grouped} in the declared trace.`);
	}
	if (compressed !== expectation.compressed) {
		addIssue(
			path,
			`Batch '${expectation.batch}' compressed=${compressed} in the declared trace.`,
		);
	}
	if (chunked !== expectation.chunked) {
		addIssue(path, `Batch '${expectation.batch}' chunked=${chunked} in the declared trace.`);
	}
	if (
		expectation.originalOperationCount !== undefined &&
		expectation.originalOperationCount !== batch.definition.operations.length
	) {
		addIssue(
			path,
			`Batch '${expectation.batch}' declares ${batch.definition.operations.length} logical operation(s).`,
		);
	}
	if (expectation.wireMessages !== undefined && expectation.wireMessages !== records.length) {
		addIssue(
			path,
			`Batch '${expectation.batch}' occupies ${records.length} sequenced message(s), not ${expectation.wireMessages}.`,
		);
	}
	if (grouped && records.length > 1 && !chunked) {
		addIssue(
			path,
			`Batch '${expectation.batch}' is grouped, so it must occupy exactly one sequenced message unless it is also chunked.`,
		);
	}
}

function validatePendingStateExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "pendingState" }>,
	path: string,
): void {
	const { addIssue } = context;
	const record = context.pendingStates.get(expectation.pendingState);
	if (record === undefined) {
		addIssue(path, `Unknown pending state '${expectation.pendingState}'.`);
		return;
	}
	if (expectation.captureKind !== undefined && expectation.captureKind !== record.kind) {
		addIssue(
			path,
			`'${expectation.pendingState}' was produced by ${record.kind} capture, not ${expectation.captureKind}.`,
		);
	}
	if (expectation.selfContained === true && record.kind !== "fullContainerState") {
		addIssue(
			path,
			`Only full-container capture is self-contained; '${expectation.pendingState}' is not.`,
		);
	}
	if (expectation.savedOps !== undefined && expectation.savedOps !== record.savedOps) {
		addIssue(
			path,
			`'${expectation.pendingState}' captured ${record.savedOps} sequenced op(s) after its base snapshot, not ${expectation.savedOps}.`,
		);
	}
	if (
		expectation.stashedOps !== undefined &&
		expectation.stashedOps !== record.stashed.length
	) {
		addIssue(
			path,
			`'${expectation.pendingState}' captured ${record.stashed.length} unsequenced local op(s), not ${expectation.stashedOps}.`,
		);
	}
	for (const operation of expectation.containsOperations ?? []) {
		if (!context.operations.has(operation)) {
			addIssue(path, `Unknown operation '${operation}'.`);
		} else if (!record.stashed.includes(operation)) {
			addIssue(
				path,
				`'${expectation.pendingState}' does not carry unsequenced operation '${operation}'.`,
			);
		}
	}
}

function validateDeliveryExpectation(
	context: ValidationContext,
	expectation: Extract<ScenarioExpectation, { kind: "delivery" }>,
	path: string,
): void {
	const client = requireKnownClient(context, expectation.client, path);
	if (client === undefined) {
		return;
	}
	checkRelation(context, expectation.loadedAt, client.basePosition, "loaded at", path);
	checkRelation(
		context,
		expectation.processedThrough,
		client.cursor,
		"processed through",
		path,
	);
}

function checkRelation(
	context: ValidationContext,
	relation: SequenceRelation | undefined,
	actual: number,
	label: string,
	path: string,
): void {
	if (relation === undefined) {
		return;
	}
	const expected = resolvePosition(context, relation.position, path, "position");
	if (expected === undefined) {
		return;
	}
	const satisfied =
		relation.relation === "equal"
			? actual === expected
			: relation.relation === "after"
				? actual > expected
				: actual >= expected;
	if (!satisfied) {
		context.addIssue(
			path,
			`Expected ${label} ${relation.relation} '${relation.position}' (position ${expected}) but the declared trace puts it at position ${actual}.`,
		);
	}
}

function validateConvergenceExpectation(
	context: ValidationContext,
	clients: readonly string[],
	path: string,
): void {
	const { addIssue } = context;
	if (clients.length < 2) {
		addIssue(path, "Convergence needs at least two clients.");
		return;
	}
	const states = clients
		.map((clientId) => ({ clientId, client: requireKnownClient(context, clientId, path) }))
		.filter(
			(entry): entry is { clientId: string; client: ClientValidationState } =>
				entry.client !== undefined,
		);
	const [first, ...rest] = states;
	if (first === undefined) {
		return;
	}
	for (const other of rest) {
		if (other.client.cursor !== first.client.cursor) {
			addIssue(
				path,
				`'${other.clientId}' processed through position ${other.client.cursor} while '${first.clientId}' processed through ${first.client.cursor}.`,
			);
		}
		for (const [operation, times] of first.client.applied) {
			if ((other.client.applied.get(operation) ?? 0) !== times) {
				addIssue(
					path,
					`'${other.clientId}' and '${first.clientId}' disagree on how many times '${operation}' was applied.`,
				);
			}
		}
		for (const operation of other.client.applied.keys()) {
			if (!first.client.applied.has(operation)) {
				addIssue(
					path,
					`'${other.clientId}' applied '${operation}' but '${first.clientId}' did not.`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Trace invariants
// ---------------------------------------------------------------------------

/**
 * Evaluates the named invariants. Every name the model accepts is backed by a real check: some
 * are accumulated while the timeline is replayed, others are computed over the trace here.
 */
function checkTraceInvariants(
	context: ValidationContext,
	invariants: readonly TraceInvariant[],
	path: string,
): void {
	const emit: AddIssue = (issuePath, message) => {
		const key = `${issuePath}|${message}`;
		if (context.emittedIssues.has(key)) {
			return;
		}
		context.emittedIssues.add(key);
		context.addIssue(issuePath, message);
	};
	for (const invariant of invariants) {
		for (const issue of context.deferred.get(invariant) ?? []) {
			emit(issue.path, issue.message);
		}
		switch (invariant) {
			case "denseTotalOrder": {
				checkDenseTotalOrder(context, emit, path);
				break;
			}
			case "clientSequenceMonotonic": {
				checkClientSequenceMonotonic(context, emit);
				break;
			}
			case "batchContiguity": {
				checkBatchContiguity(context, emit, path);
				break;
			}
			case "causalReferenceSequence": {
				checkCausalReferenceSequence(context, emit);
				break;
			}
			case "minimumSequenceMonotonic": {
				checkMinimumSequenceMonotonic(context, emit);
				break;
			}
			case "wireReconstruction": {
				checkWireReconstruction(context, emit, path);
				break;
			}
			case "exactlyOnceApplication": {
				checkExactlyOnceApplication(context, emit, path);
				break;
			}
			default: {
				checkOrderedDelivery(context, emit);
				break;
			}
		}
	}
}

function checkDenseTotalOrder(
	context: ValidationContext,
	addIssue: AddIssue,
	path: string,
): void {
	if (context.positions.size !== context.trace.length) {
		addIssue(path, "The total order contains positions that are not uniquely named.");
	}
	for (const [offset, record] of context.trace.entries()) {
		if (record.index !== offset + 1) {
			addIssue(
				record.path,
				`'${record.entry.at}' does not occupy a dense position in the total order.`,
			);
		}
	}
}

function checkClientSequenceMonotonic(context: ValidationContext, addIssue: AddIssue): void {
	const seen = new Map<string, number>();
	for (const record of context.trace) {
		const client = submitterOf(record.entry);
		if (client === undefined || record.entry.clientSequence === undefined) {
			continue;
		}
		const key = `${client}#${record.epoch}`;
		const previous = seen.get(key);
		if (previous !== undefined && record.entry.clientSequence <= previous) {
			addIssue(
				record.path,
				`Client sequence number ${record.entry.clientSequence} at '${record.entry.at}' does not advance within '${client}' current connection.`,
			);
		}
		seen.set(key, record.entry.clientSequence);
	}
}

function checkCausalReferenceSequence(context: ValidationContext, addIssue: AddIssue): void {
	for (const record of context.trace) {
		if (record.referenceIndex >= record.index) {
			addIssue(
				record.path,
				`Reference sequence for '${record.entry.at}' must precede its own position in the total order.`,
			);
		}
		if (record.referenceIndex > record.maxReference) {
			addIssue(
				record.path,
				`Reference sequence for '${record.entry.at}' is ahead of what its submitter had processed.`,
			);
		}
	}
}

function checkMinimumSequenceMonotonic(context: ValidationContext, addIssue: AddIssue): void {
	let previous = 0;
	for (const record of context.trace) {
		if (record.minimumIndex < previous) {
			addIssue(
				record.path,
				`Minimum sequence number moved backwards at '${record.entry.at}'.`,
			);
		}
		if (record.minimumIndex > record.referenceIndex) {
			addIssue(
				record.path,
				`Minimum sequence number at '${record.entry.at}' passes the reference sequence number of a live submitter.`,
			);
		}
		previous = Math.max(previous, record.minimumIndex);
	}
}

function checkOrderedDelivery(context: ValidationContext, addIssue: AddIssue): void {
	const reached = new Map<string, number>();
	for (const delivery of context.deliveries) {
		if (delivery.rejection !== undefined) {
			addIssue(delivery.path, delivery.rejection);
			continue;
		}
		const previous = reached.get(delivery.client) ?? 0;
		if (delivery.to < previous) {
			addIssue(
				delivery.path,
				`'${delivery.client}' cannot move its processing position backwards.`,
			);
		}
		reached.set(delivery.client, Math.max(previous, delivery.to));
	}
}

function submitterOf(entry: TraceEntry): string | undefined {
	return entry.kind === "summaryAck" || entry.kind === "summaryNack"
		? undefined
		: entry.client;
}

function checkBatchContiguity(
	context: ValidationContext,
	addIssue: AddIssue,
	path: string,
): void {
	for (const batch of context.batches.values()) {
		if (batch.entries.length === 0) {
			continue;
		}
		// A reconnect starts a new transmission epoch. Within one epoch, every wire message for
		// the batch must be adjacent in the total order.
		const transmissions = new Map<string, number[]>();
		for (const index of batch.entries) {
			const record = context.trace[index - 1];
			const key =
				record?.entry.kind === "operations"
					? `${record.entry.client}:${record.epoch}`
					: `unknown:${index}`;
			const existing = transmissions.get(key);
			if (existing === undefined) {
				transmissions.set(key, [index]);
			} else {
				existing.push(index);
			}
		}
		for (const indexes of transmissions.values()) {
			const sorted = [...indexes].sort((left, right) => left - right);
			if (
				sorted.some(
					(index, position) => position > 0 && index !== (sorted[position - 1] ?? index) + 1,
				)
			) {
				addIssue(
					path,
					`Batch '${batch.id}' is interleaved with another sequenced message within one transmission.`,
				);
			}
			const records = sorted
				.map((index) => context.trace[index - 1])
				.filter((record): record is TraceRecord => record !== undefined);
			const clients = new Set(
				records.map((record) =>
					record.entry.kind === "operations" ? record.entry.client : "",
				),
			);
			if (clients.size > 1) {
				addIssue(
					path,
					`Batch '${batch.id}' has wire messages from more than one client in a single run.`,
				);
			}
			const references = new Set(records.map((record) => record.referenceIndex));
			if (references.size > 1) {
				addIssue(
					path,
					`Batch '${batch.id}' spans more than one reference sequence number; a batch is submitted at a single reference position.`,
				);
			}
			checkBatchMarkers(batch.id, records, addIssue, path);
		}
	}
}

function checkBatchMarkers(
	batchId: string,
	records: readonly TraceRecord[],
	addIssue: AddIssue,
	path: string,
): void {
	const chunked = records.some(
		(record) =>
			record.entry.kind === "operations" && record.entry.virtualization?.chunk !== undefined,
	);
	if (chunked) {
		// Batch begin/end markers describe logical batch structure, not wire fragments.
		return;
	}
	const positions = records.map((record) =>
		record.entry.kind === "operations" ? record.entry.batchPosition : undefined,
	);
	if (positions.every((position) => position === undefined)) {
		return;
	}
	if (records.length === 1) {
		if (positions[0] !== "single") {
			addIssue(
				path,
				`Batch '${batchId}' occupies one wire message and must be marked 'single'.`,
			);
		}
		return;
	}
	for (const [index, position] of positions.entries()) {
		const expected =
			index === 0 ? "start" : index === positions.length - 1 ? "end" : "continuation";
		if (position !== expected) {
			addIssue(
				path,
				`Batch '${batchId}' wire message ${index + 1} should be marked '${expected}'.`,
			);
		}
	}
}

function checkWireReconstruction(
	context: ValidationContext,
	addIssue: AddIssue,
	path: string,
): void {
	const runs = new Map<string, TraceRecord[]>();
	for (const record of context.trace) {
		if (record.entry.kind !== "operations") {
			continue;
		}
		const chunk = record.entry.virtualization?.chunk;
		if (chunk === undefined) {
			continue;
		}
		const key = `${record.entry.client}:${record.entry.batch ?? ""}:${chunk.count}`;
		const existing = runs.get(key);
		if (existing === undefined) {
			runs.set(key, [record]);
		} else {
			existing.push(record);
		}
	}

	for (const [key, records] of runs) {
		const first = records[0];
		if (first?.entry.kind !== "operations") {
			continue;
		}
		const chunk = first.entry.virtualization?.chunk;
		if (chunk === undefined) {
			continue;
		}
		const indexes = records.map((record) =>
			record.entry.kind === "operations"
				? (record.entry.virtualization?.chunk?.index ?? 0)
				: 0,
		);
		const expected = indexes.every((value, position) => value === position + 1);
		if (!expected) {
			addIssue(
				path,
				`Chunk run '${key}' is not delivered in ascending, gap-free chunk order.`,
			);
			continue;
		}
		const contiguous = records.every(
			(record, position) =>
				position === 0 || record.index === (records[position - 1]?.index ?? record.index) + 1,
		);
		if (!contiguous) {
			addIssue(
				path,
				`Chunk run '${key}' is interleaved with other sequenced messages; chunks of one payload arrive consecutively.`,
			);
		}
		if (records.length === chunk.count) {
			continue;
		}
		const last = records[records.length - 1];
		const client = context.clients.get(first.entry.client);
		const abandoned =
			last !== undefined &&
			client?.disconnectedAfter !== undefined &&
			client.disconnectedAfter >= last.index;
		if (!abandoned) {
			addIssue(
				path,
				`Chunk run '${key}' delivered ${records.length} of ${chunk.count} chunks and was never reconstructed. Either sequence the remaining chunks or disconnect the submitter to abandon them.`,
			);
		}
	}
}

function checkExactlyOnceApplication(
	context: ValidationContext,
	addIssue: AddIssue,
	path: string,
): void {
	for (const [clientId, client] of context.clients) {
		for (const [operation, times] of client.applied) {
			if (times > 1) {
				addIssue(
					path,
					`'${clientId}' applied logical operation '${operation}' ${times} times.`,
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePosition(
	context: ValidationContext,
	reference: SequenceRef,
	path: string,
	label: string,
): number | undefined {
	if (reference === baselineSequenceRef) {
		return 0;
	}
	if (reference === latestSequenceRef) {
		return context.trace.length;
	}
	const position = context.positions.get(reference);
	if (position === undefined) {
		context.addIssue(path, `Unknown ${label} '${reference}'.`);
	}
	return position;
}

function recordPendingState(
	context: ValidationContext,
	id: string,
	path: string,
	record: PendingStateRecord,
): void {
	if (context.pendingStates.has(id)) {
		context.addIssue(path, `Pending state '${id}' already exists.`);
		return;
	}
	context.pendingStates.set(id, record);
}

function requireClient(
	context: ValidationContext,
	clientId: string,
	path: string,
): ClientValidationState | undefined {
	const client = context.clients.get(clientId);
	if (client === undefined) {
		context.addIssue(path, `Unknown client '${clientId}'.`);
	}
	return client;
}

function requireOpenClient(
	context: ValidationContext,
	clientId: string,
	path: string,
): ClientValidationState | undefined {
	const client = requireClient(context, clientId, path);
	if (client !== undefined && client.phase !== "open") {
		context.addIssue(path, `Client '${clientId}' is not open.`);
		return undefined;
	}
	return client;
}

function requireSubmittableClient(
	context: ValidationContext,
	clientId: string,
	path: string,
): ClientValidationState | undefined {
	const client = requireOpenClient(context, clientId, path);
	if (client !== undefined && client.attach !== "attached") {
		context.addIssue(
			path,
			`Client '${clientId}' cannot submit runtime operations while detached.`,
		);
	}
	return client;
}

/**
 * A message only reaches the total order when its submitter has a live outbound path to the
 * service at that point in the timeline.
 */
function requireSequencingClient(
	context: ValidationContext,
	clientId: string,
	path: string,
): void {
	const client = requireOpenClient(context, clientId, path);
	if (client === undefined) {
		return;
	}
	if (client.attach !== "attached" || client.environment !== "service") {
		context.addIssue(
			path,
			`'${clientId}' is not attached to a service-backed document, so nothing it submits can be sequenced.`,
		);
		return;
	}
	if (client.connection !== "connected") {
		context.addIssue(
			path,
			`'${clientId}' is disconnected, so nothing it submitted can be sequenced until it reconnects and resubmits.`,
		);
		return;
	}
	if (client.connectionMode === "read") {
		context.addIssue(
			path,
			`'${clientId}' is connected in read mode, so its pending submissions cannot be sequenced until it transitions to write mode.`,
		);
		return;
	}
	if (client.outbound === "paused") {
		context.addIssue(
			path,
			`'${clientId}' has a paused outbound queue, so nothing it submitted can reach the service.`,
		);
	}
}

function requireNotLoaded(
	client: ClientValidationState,
	path: string,
	addIssue: AddIssue,
): void {
	if (client.phase !== "notLoaded") {
		addIssue(path, `Client '${client.definition.id}' has already been loaded.`);
	}
}

function requireDataStore(context: ValidationContext, dataStore: string, path: string): void {
	if (!context.dataStores.has(dataStore)) {
		context.addIssue(path, `Unknown DataStore '${dataStore}'.`);
	}
}

function requireKnownClient(
	context: ValidationContext,
	clientId: string,
	path: string,
): ClientValidationState | undefined {
	const client = context.clients.get(clientId);
	if (client === undefined) {
		context.addIssue(path, `Unknown client '${clientId}'.`);
	}
	return client;
}

function validateUnique(
	values: readonly string[],
	path: string,
	label: string,
	addIssue: AddIssue,
): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			addIssue(path, `${label} '${value}' is declared more than once.`);
		}
		seen.add(value);
	}
}
