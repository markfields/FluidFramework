/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type CapturedContainerStateKind,
	type ClientDefinition,
	type ConnectionEnvironment,
	type ConnectionState,
	type DataStoreDefinition,
	type FluidScenario,
	type ScenarioCommand,
	type ScenarioExpectation,
	type ScenarioStep,
	type SummaryState,
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

interface ClientValidationState {
	readonly definition: ClientDefinition;
	phase: "notLoaded" | "open" | "closed";
	attach?: "detached" | "attaching" | "attached";
	connection?: ConnectionState;
	environment: ConnectionEnvironment;
	inbound: "running" | "paused";
	outbound: "running" | "paused";
}

export function assertValidScenario(scenario: FluidScenario): void {
	const issues = validateScenario(scenario);
	if (issues.length > 0) {
		throw new ScenarioValidationError(issues);
	}
}

export function validateScenario(scenario: FluidScenario): readonly ScenarioValidationIssue[] {
	const issues: ScenarioValidationIssue[] = [];
	const addIssue = (path: string, message: string): void => {
		issues.push({ path, message });
	};

	validateHeader(scenario, addIssue);
	validateRuntimeConfiguration(scenario, addIssue);

	const clientStates = createClientStates(scenario.clients, addIssue);
	const dataStores = new Map(
		scenario.document.dataStores.map((dataStore) => [dataStore.id, dataStore]),
	);
	validateUnique(
		scenario.document.dataStores.map((dataStore) => dataStore.id),
		"document.dataStores",
		"DataStore",
		addIssue,
	);

	const createdDataStores = new Set(
		scenario.document.dataStores
			.filter((dataStore) => dataStore.initiallyVisible !== false)
			.map((dataStore) => dataStore.id),
	);
	const visibleDataStores = new Set(createdDataStores);
	const serializedContainers = new Map<string, "detached" | "attaching">();
	const snapshots = new Set<string>();
	const pendingStates = new Map<string, CapturedContainerStateKind>();
	const summaries = new Map<string, SummaryState>();
	const operations = new Set<string>();
	const batches = new Set<string>();

	let usesFullOfflineState = false;

	for (const [index, step] of scenario.steps.entries()) {
		const path = `steps[${index}]`;
		if (step.kind === "command") {
			if (step.command.kind === "captureFullContainerState") {
				usesFullOfflineState = true;
			}
			if (
				step.command.kind === "load" &&
				step.command.options.from.kind === "pendingState" &&
				step.command.options.from.mode === "frozen"
			) {
				usesFullOfflineState = true;
			}
			validateCommand({
				command: step.command,
				path,
				addIssue,
				clientStates,
				dataStores,
				createdDataStores,
				visibleDataStores,
				serializedContainers,
				snapshots,
				pendingStates,
				summaries,
				operations,
				batches,
			});
		} else if (step.kind === "expectation") {
			validateExpectation({
				expectation: step.expectation,
				path,
				addIssue,
				clientStates,
				dataStores,
				snapshots,
				pendingStates,
				summaries,
				operations,
				batches,
			});
		} else if (step.text.trim().length === 0) {
			addIssue(path, "Notes must contain text.");
		}
	}

	if (usesFullOfflineState) {
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
		if (runtime?.enableBatchIdTracking !== true) {
			addIssue(
				"document.runtime.enableBatchIdTracking",
				"Writable frozen loading requires batch-id tracking.",
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

	return issues;
}

function validateHeader(
	scenario: FluidScenario,
	addIssue: (path: string, message: string) => void,
): void {
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

function validateRuntimeConfiguration(
	scenario: FluidScenario,
	addIssue: (path: string, message: string) => void,
): void {
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
		runtime?.enableDataVirtualization !== true
	) {
		addIssue(
			"document.runtime.enableDataVirtualization",
			"Loading-group DataStores require data virtualization.",
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

function createClientStates(
	clients: readonly ClientDefinition[],
	addIssue: (path: string, message: string) => void,
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
				phase: "notLoaded",
				environment: "none",
				inbound: "running",
				outbound: "running",
			},
		]),
	);
}

interface CommandValidationContext {
	readonly command: ScenarioCommand;
	readonly path: string;
	readonly addIssue: (path: string, message: string) => void;
	readonly clientStates: Map<string, ClientValidationState>;
	readonly dataStores: ReadonlyMap<string, DataStoreDefinition>;
	readonly createdDataStores: Set<string>;
	readonly visibleDataStores: Set<string>;
	readonly serializedContainers: Map<string, "detached" | "attaching">;
	readonly snapshots: Set<string>;
	readonly pendingStates: Map<string, CapturedContainerStateKind>;
	readonly summaries: Map<string, SummaryState>;
	readonly operations: Set<string>;
	readonly batches: Set<string>;
}

function validateCommand(context: CommandValidationContext): void {
	const { command, path, addIssue } = context;
	switch (command.kind) {
		case "createDetached": {
			const client = requireClient(context, command.client);
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
			const client = requireOpenClient(context, command.client);
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
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				if (client.attach !== "detached") {
					addIssue(path, "Beginning attach requires a detached client.");
				} else {
					client.attach = "attaching";
					client.connection = "disconnected";
					client.environment = "service";
				}
			}
			break;
		}
		case "attach": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				if (client.attach !== "detached") {
					addIssue(path, "Attach requires a detached client.");
				} else {
					client.attach = "attached";
					client.connection = "connected";
					client.environment = "service";
				}
			}
			break;
		}
		case "completeAttach": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				if (client.attach !== "attaching") {
					addIssue(path, "Completing attach requires an attaching client.");
				} else {
					client.attach = "attached";
					client.connection = "connected";
					client.environment = "service";
				}
			}
			break;
		}
		case "load": {
			const client = requireClient(context, command.client);
			if (client === undefined) {
				break;
			}
			requireNotLoaded(client, path, addIssue);
			const source = command.options.from;
			if (source.kind === "service") {
				if (source.snapshot !== undefined && !context.snapshots.has(source.snapshot)) {
					addIssue(path, `Unknown service snapshot '${source.snapshot}'.`);
				}
				client.attach = "attached";
				client.connection =
					command.options.deltaConnection === "none" ? "disconnected" : "connected";
				client.environment = "service";
			} else if (source.kind === "pendingState") {
				const pendingKind = context.pendingStates.get(source.pendingState);
				if (pendingKind === undefined) {
					addIssue(path, `Unknown pending state '${source.pendingState}'.`);
				}
				if (source.mode === "frozen" && pendingKind !== "fullContainerState") {
					addIssue(path, "Frozen loading requires captureFullContainerState output.");
				}
				client.attach = "attached";
				client.connection = "connected";
				client.environment = source.mode === "frozen" ? "frozen" : "service";
			} else {
				const serializedAttachState = context.serializedContainers.get(source.snapshot);
				if (serializedAttachState === undefined) {
					addIssue(path, `Unknown serialized container '${source.snapshot}'.`);
				}
				client.attach = serializedAttachState === "attaching" ? "attached" : "detached";
				client.connection = "disconnected";
				client.environment = serializedAttachState === "attaching" ? "service" : "none";
			}
			if (
				command.options.pauseAt !== undefined &&
				!context.summaries.has(command.options.pauseAt.summary)
			) {
				addIssue(path, `Unknown pause summary '${command.options.pauseAt.summary}'.`);
			}
			client.phase = "open";
			break;
		}
		case "connect": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				if (client.attach !== "attached" || client.environment !== "service") {
					addIssue(path, "Connect requires an attached service-backed client.");
				} else {
					client.connection = "connected";
				}
			}
			break;
		}
		case "disconnect": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				if (client.attach !== "attached") {
					addIssue(path, "Disconnect requires an attached client.");
				} else {
					client.connection = "disconnected";
				}
			}
			break;
		}
		case "close": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				client.phase = "closed";
				client.connection = "disconnected";
			}
			break;
		}
		case "createDataStore": {
			requireOpenClient(context, command.client);
			requireDataStore(context, command.dataStore);
			if (context.createdDataStores.has(command.dataStore)) {
				addIssue(path, `DataStore '${command.dataStore}' already exists.`);
			} else {
				context.createdDataStores.add(command.dataStore);
			}
			break;
		}
		case "makeDataStoreVisible": {
			requireOpenClient(context, command.client);
			requireDataStore(context, command.dataStore);
			if (!context.createdDataStores.has(command.dataStore)) {
				addIssue(path, `DataStore '${command.dataStore}' has not been created.`);
			} else {
				context.visibleDataStores.add(command.dataStore);
			}
			break;
		}
		case "realizeDataStore": {
			requireOpenClient(context, command.client);
			requireDataStore(context, command.dataStore);
			if (!context.visibleDataStores.has(command.dataStore)) {
				addIssue(path, `DataStore '${command.dataStore}' is not visible.`);
			}
			break;
		}
		case "submitOperation": {
			requireSubmittableClient(context, command.client);
			validateOperation(context, command.operation.id, command.operation.dataStore, path);
			break;
		}
		case "submitBatch": {
			requireSubmittableClient(context, command.client);
			recordUniqueArtifact(context.batches, command.batch.id, path, "Batch", addIssue);
			if (command.batch.operations.length === 0) {
				addIssue(path, "A submitted batch must contain at least one operation.");
			}
			for (const operation of command.batch.operations) {
				validateOperation(context, operation.id, operation.dataStore, path);
			}
			break;
		}
		case "pauseProcessing":
		case "resumeProcessing": {
			const client = requireOpenClient(context, command.client);
			if (client !== undefined) {
				client[command.queue] = command.kind === "pauseProcessing" ? "paused" : "running";
			}
			break;
		}
		case "synchronize": {
			for (const clientId of command.clients) {
				requireOpenClient(context, clientId);
			}
			break;
		}
		case "capturePendingState": {
			const client = requireOpenClient(context, command.client);
			if (client?.attach !== "attached") {
				addIssue(path, "Pending local state capture requires an attached open client.");
			}
			recordUniquePendingState(
				context.pendingStates,
				command.pendingState,
				"pendingLocalState",
				path,
				addIssue,
			);
			break;
		}
		case "captureFullContainerState": {
			recordUniquePendingState(
				context.pendingStates,
				command.pendingState,
				"fullContainerState",
				path,
				addIssue,
			);
			break;
		}
		case "requestLatestSnapshotRefresh": {
			const client = requireOpenClient(context, command.client);
			if (client?.environment !== "service") {
				addIssue(path, "Latest-snapshot refresh requires service-backed storage.");
			}
			if (command.snapshot !== undefined) {
				recordUniqueArtifact(context.snapshots, command.snapshot, path, "Snapshot", addIssue);
			}
			break;
		}
		case "summarize": {
			const client = requireOpenClient(context, command.client);
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
				context.summaries.set(command.summary, "local");
			}
			break;
		}
		case "acknowledgeSummary": {
			if (!context.summaries.has(command.summary)) {
				addIssue(path, `Unknown summary '${command.summary}'.`);
			} else {
				context.summaries.set(command.summary, "acked");
			}
			recordUniqueArtifact(context.snapshots, command.snapshot, path, "Snapshot", addIssue);
			break;
		}
		case "nackSummary": {
			if (!context.summaries.has(command.summary)) {
				addIssue(path, `Unknown summary '${command.summary}'.`);
			} else {
				context.summaries.set(command.summary, "nacked");
			}
			break;
		}
		default: {
			const exhaustiveCommand: never = command;
			return exhaustiveCommand;
		}
	}
}

interface ExpectationValidationContext {
	readonly expectation: ScenarioExpectation;
	readonly path: string;
	readonly addIssue: (path: string, message: string) => void;
	readonly clientStates: ReadonlyMap<string, ClientValidationState>;
	readonly dataStores: ReadonlyMap<string, DataStoreDefinition>;
	readonly snapshots: ReadonlySet<string>;
	readonly pendingStates: ReadonlyMap<string, CapturedContainerStateKind>;
	readonly summaries: ReadonlyMap<string, SummaryState>;
	readonly operations: ReadonlySet<string>;
	readonly batches: ReadonlySet<string>;
}

function validateExpectation(context: ExpectationValidationContext): void {
	const { expectation, path, addIssue } = context;
	switch (expectation.kind) {
		case "clientState":
			requireKnownClient(context.clientStates, expectation.client, path, addIssue);
			break;
		case "operation":
			requireKnownClient(context.clientStates, expectation.client, path, addIssue);
			requireKnown(context.operations, expectation.operation, path, "operation", addIssue);
			break;
		case "batchVirtualization":
			requireKnown(context.batches, expectation.batch, path, "batch", addIssue);
			break;
		case "pendingReplay":
			for (const batch of expectation.batches) {
				requireKnown(context.batches, batch, path, "batch", addIssue);
			}
			for (const batch of expectation.rebasedBatches ?? []) {
				requireKnown(context.batches, batch, path, "batch", addIssue);
			}
			break;
		case "pendingState":
			if (!context.pendingStates.has(expectation.pendingState)) {
				addIssue(path, `Unknown pending state '${expectation.pendingState}'.`);
			}
			for (const operation of expectation.containsOperations ?? []) {
				requireKnown(context.operations, operation, path, "operation", addIssue);
			}
			break;
		case "summary":
			if (!context.summaries.has(expectation.summary)) {
				addIssue(path, `Unknown summary '${expectation.summary}'.`);
			}
			for (const dataStore of Object.keys(expectation.dataStores ?? {})) {
				if (!context.dataStores.has(dataStore)) {
					addIssue(path, `Unknown DataStore '${dataStore}'.`);
				}
			}
			break;
		case "dataStore":
			requireKnownClient(context.clientStates, expectation.client, path, addIssue);
			if (!context.dataStores.has(expectation.dataStore)) {
				addIssue(path, `Unknown DataStore '${expectation.dataStore}'.`);
			}
			for (const operation of expectation.containsOperations ?? []) {
				requireKnown(context.operations, operation, path, "operation", addIssue);
			}
			break;
		case "snapshotFetch":
			requireKnownClient(context.clientStates, expectation.client, path, addIssue);
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
		case "sequencePosition":
			requireKnownClient(context.clientStates, expectation.client, path, addIssue);
			for (const position of [expectation.initial, expectation.last]) {
				if (position !== undefined && !context.summaries.has(position.summary)) {
					addIssue(path, `Unknown summary '${position.summary}'.`);
				}
			}
			break;
		default: {
			const exhaustiveExpectation: never = expectation;
			return exhaustiveExpectation;
		}
	}
}

function requireClient(
	context: CommandValidationContext,
	clientId: string,
): ClientValidationState | undefined {
	const client = context.clientStates.get(clientId);
	if (client === undefined) {
		context.addIssue(context.path, `Unknown client '${clientId}'.`);
	}
	return client;
}

function requireOpenClient(
	context: CommandValidationContext,
	clientId: string,
): ClientValidationState | undefined {
	const client = requireClient(context, clientId);
	if (client !== undefined && client.phase !== "open") {
		context.addIssue(context.path, `Client '${clientId}' is not open.`);
		return undefined;
	}
	return client;
}

function requireSubmittableClient(
	context: CommandValidationContext,
	clientId: string,
): ClientValidationState | undefined {
	const client = requireOpenClient(context, clientId);
	if (client !== undefined && client.attach !== "attached") {
		context.addIssue(
			context.path,
			`Client '${clientId}' cannot submit runtime operations while detached.`,
		);
	}
	return client;
}

function requireNotLoaded(
	client: ClientValidationState,
	path: string,
	addIssue: (path: string, message: string) => void,
): void {
	if (client.phase !== "notLoaded") {
		addIssue(path, `Client '${client.definition.id}' has already been loaded.`);
	}
}

function requireDataStore(context: CommandValidationContext, dataStore: string): void {
	if (!context.dataStores.has(dataStore)) {
		context.addIssue(context.path, `Unknown DataStore '${dataStore}'.`);
	}
}

function validateOperation(
	context: CommandValidationContext,
	operation: string,
	dataStore: string,
	path: string,
): void {
	requireDataStore(context, dataStore);
	if (!context.visibleDataStores.has(dataStore)) {
		context.addIssue(path, `DataStore '${dataStore}' is not visible.`);
	}
	recordUniqueArtifact(context.operations, operation, path, "Operation", context.addIssue);
}

function recordUniquePendingState(
	pendingStates: Map<string, CapturedContainerStateKind>,
	id: string,
	kind: CapturedContainerStateKind,
	path: string,
	addIssue: (path: string, message: string) => void,
): void {
	if (pendingStates.has(id)) {
		addIssue(path, `Pending state '${id}' already exists.`);
	} else {
		pendingStates.set(id, kind);
	}
}

function recordUniqueArtifact(
	artifacts: Set<string>,
	id: string,
	path: string,
	label: string,
	addIssue: (path: string, message: string) => void,
): void {
	if (artifacts.has(id)) {
		addIssue(path, `${label} '${id}' already exists.`);
	} else {
		artifacts.add(id);
	}
}

function requireKnownClient(
	clients: ReadonlyMap<string, ClientValidationState>,
	id: string,
	path: string,
	addIssue: (path: string, message: string) => void,
): void {
	if (!clients.has(id)) {
		addIssue(path, `Unknown client '${id}'.`);
	}
}

function requireKnown(
	known: ReadonlySet<string>,
	id: string,
	path: string,
	label: string,
	addIssue: (path: string, message: string) => void,
): void {
	if (!known.has(id)) {
		addIssue(path, `Unknown ${label} '${id}'.`);
	}
}

function validateUnique(
	values: readonly string[],
	path: string,
	label: string,
	addIssue: (path: string, message: string) => void,
): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			addIssue(path, `${label} '${value}' is declared more than once.`);
		}
		seen.add(value);
	}
}
