/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type BatchDefinition,
	type ClientDefinition,
	type ClientStateExpectation,
	type DataStoreOperation,
	type FluidScenario,
	type LoadOptions,
	type PendingStateExpectation,
	type ScenarioCoverage,
	type ScenarioSource,
	type ScenarioStep,
	type SequencePositionExpectation,
	type SnapshotFetchExpectation,
	type SummaryExpectation,
	type SummaryState,
	type DocumentDefinition,
	fluidScenarioFormatVersion,
	type OperationDeliveryState,
	type ProcessingQueue,
	type RuntimeConfiguration,
	type DataStoreDefinition,
} from "./model.js";

type StepRecorder = (step: ScenarioStep) => void;

export interface ScenarioSourceStage {
	fromTest(source: ScenarioSource): ScenarioDocumentStage;
}

export interface ScenarioDocumentStage {
	document(document: DocumentDefinition): ScenarioClientStage;
}

export interface ScenarioClientStage {
	clients<
		const Definitions extends readonly [
			ClientDefinition<string>,
			...ClientDefinition<string>[],
		],
	>(...clients: Definitions): ScenarioCoverageStage<Definitions[number]["id"]>;
}

export interface ScenarioCoverageStage<ClientName extends string> {
	covers(
		first: ScenarioCoverage,
		...rest: readonly ScenarioCoverage[]
	): ScenarioStepsStage<ClientName>;
}

export interface ScenarioStepsStage<ClientName extends string> {
	steps(define: (steps: ScenarioSteps<ClientName>) => void): FluidScenario<ClientName>;
}

export interface ScenarioSteps<ClientName extends string> {
	client(client: ClientName): ClientActions;
	processing(client: ClientName): ProcessingActions;
	service(): ServiceActions<ClientName>;
	expectClient(client: ClientName): ClientExpectationScope;
	expectOperation(operation: string): OperationExpectationTarget<ClientName>;
	expectBatch(batch: string): BatchExpectationScope;
	expectPendingReplay(): PendingReplayExpectationScope;
	expectPendingState(pendingState: string): PendingStateExpectationScope;
	expectSummary(summary: string): SummaryExpectationScope;
	expectDataStore(client: ClientName, dataStore: string): DataStoreExpectationScope;
	expectSnapshotFetch(client: ClientName): SnapshotFetchExpectationScope;
	expectSequence(client: ClientName): SequenceExpectationScope;
	note(text: string): void;
}

export interface ClientActions {
	createDetached(): void;
	serialize(snapshot: string): void;
	beginAttach(): void;
	attach(): void;
	load(options: LoadOptions): void;
	connect(): void;
	disconnect(): void;
	close(): void;
	createDataStore(dataStore: string): void;
	makeDataStoreVisible(dataStore: string): void;
	realizeDataStore(dataStore: string): void;
	submitOperation(operation: DataStoreOperation): void;
	submitBatch(batch: BatchDefinition): void;
	capturePendingState(pendingState: string): void;
	requestLatestSnapshotRefresh(snapshot?: string): void;
	summarize(options: {
		readonly id: string;
		readonly fullTree?: boolean;
		readonly trackState?: boolean;
	}): void;
}

export interface ProcessingActions {
	pause(queue: ProcessingQueue): void;
	resume(queue: ProcessingQueue): void;
}

export interface ServiceActions<ClientName extends string> {
	synchronize(...clients: readonly ClientName[]): void;
	captureFullContainerState(pendingState: string): void;
	completeAttach(client: ClientName): void;
	acknowledgeSummary(summary: string, snapshot: string): void;
	nackSummary(summary: string, retryAfterSeconds?: number): void;
}

export interface ClientExpectationScope {
	toBe(state: ClientStateExpectation["state"]): void;
}

export interface OperationExpectationTarget<ClientName extends string> {
	at(client: ClientName): OperationExpectationScope;
}

export interface OperationExpectationScope {
	toBe(state: OperationDeliveryState): void;
}

export interface BatchExpectationScope {
	toBeVirtualizedAs(options: {
		readonly grouped: boolean;
		readonly compressed: boolean;
		readonly chunked: boolean;
		readonly originalOperationCount?: number;
	}): void;
}

export interface PendingReplayExpectationScope {
	toPreserve(options: {
		readonly batches: readonly string[];
		readonly rebasedBatches?: readonly string[];
	}): void;
}

export interface PendingStateExpectationScope {
	toContain(state: Omit<PendingStateExpectation, "kind" | "pendingState">): void;
}

export interface SummaryExpectationScope {
	toBe(
		state: SummaryState,
		options?: Omit<SummaryExpectation, "kind" | "summary" | "state">,
	): void;
}

export interface DataStoreExpectationScope {
	toBe(
		realization: "unloaded" | "loaded",
		options?: {
			readonly containsOperations?: readonly string[];
		},
	): void;
}

export interface SnapshotFetchExpectationScope {
	toBe(state: Omit<SnapshotFetchExpectation, "kind" | "client">): void;
}

export interface SequenceExpectationScope {
	toBe(state: Omit<SequencePositionExpectation, "kind" | "client">): void;
}

export function interactiveClient<const Name extends string>(
	id: Name,
): ClientDefinition<Name> {
	return { id, role: "interactive" };
}

export function summarizerClient<const Name extends string>(id: Name): ClientDefinition<Name> {
	return { id, role: "summarizer" };
}

export function document(
	id: string,
	dataStores: readonly DataStoreDefinition[],
	runtime?: RuntimeConfiguration,
): DocumentDefinition {
	return { id, dataStores, ...(runtime === undefined ? {} : { runtime }) };
}

export function fluidScenario(name: string): ScenarioSourceStage {
	return new SourceStageImpl(name);
}

class SourceStageImpl implements ScenarioSourceStage {
	public constructor(private readonly name: string) {}

	public fromTest(source: ScenarioSource): ScenarioDocumentStage {
		return new DocumentStageImpl(this.name, source);
	}
}

class DocumentStageImpl implements ScenarioDocumentStage {
	public constructor(
		private readonly name: string,
		private readonly source: ScenarioSource,
	) {}

	public document(documentDefinition: DocumentDefinition): ScenarioClientStage {
		return new ClientStageImpl(this.name, this.source, documentDefinition);
	}
}

class ClientStageImpl implements ScenarioClientStage {
	public constructor(
		private readonly name: string,
		private readonly source: ScenarioSource,
		private readonly documentDefinition: DocumentDefinition,
	) {}

	public clients<
		const Definitions extends readonly [
			ClientDefinition<string>,
			...ClientDefinition<string>[],
		],
	>(...clients: Definitions): ScenarioCoverageStage<Definitions[number]["id"]> {
		return new CoverageStageImpl(this.name, this.source, this.documentDefinition, clients);
	}
}

class CoverageStageImpl<ClientName extends string>
	implements ScenarioCoverageStage<ClientName>
{
	public constructor(
		private readonly name: string,
		private readonly source: ScenarioSource,
		private readonly documentDefinition: DocumentDefinition,
		private readonly clientDefinitions: readonly ClientDefinition<ClientName>[],
	) {}

	public covers(
		first: ScenarioCoverage,
		...rest: readonly ScenarioCoverage[]
	): ScenarioStepsStage<ClientName> {
		return new StepsStageImpl(
			this.name,
			this.source,
			this.documentDefinition,
			this.clientDefinitions,
			[first, ...rest],
		);
	}
}

class StepsStageImpl<ClientName extends string> implements ScenarioStepsStage<ClientName> {
	public constructor(
		private readonly name: string,
		private readonly source: ScenarioSource,
		private readonly documentDefinition: DocumentDefinition,
		private readonly clientDefinitions: readonly ClientDefinition<ClientName>[],
		private readonly coverage: readonly ScenarioCoverage[],
	) {}

	public steps(define: (steps: ScenarioSteps<ClientName>) => void): FluidScenario<ClientName> {
		const recordedSteps: ScenarioStep[] = [];
		define(new ScenarioStepsImpl((step) => recordedSteps.push(step)));
		return {
			formatVersion: fluidScenarioFormatVersion,
			name: this.name,
			source: this.source,
			document: this.documentDefinition,
			clients: this.clientDefinitions,
			coverage: this.coverage,
			steps: recordedSteps,
		};
	}
}

class ScenarioStepsImpl<ClientName extends string> implements ScenarioSteps<ClientName> {
	public constructor(private readonly record: StepRecorder) {}

	public client(client: ClientName): ClientActions {
		return new ClientActionsImpl(client, this.record);
	}

	public processing(client: ClientName): ProcessingActions {
		return new ProcessingActionsImpl(client, this.record);
	}

	public service(): ServiceActions<ClientName> {
		return new ServiceActionsImpl(this.record);
	}

	public expectClient(client: ClientName): ClientExpectationScope {
		return new ClientExpectationScopeImpl(client, this.record);
	}

	public expectOperation(operation: string): OperationExpectationTarget<ClientName> {
		return new OperationExpectationTargetImpl(operation, this.record);
	}

	public expectBatch(batch: string): BatchExpectationScope {
		return new BatchExpectationScopeImpl(batch, this.record);
	}

	public expectPendingReplay(): PendingReplayExpectationScope {
		return new PendingReplayExpectationScopeImpl(this.record);
	}

	public expectPendingState(pendingState: string): PendingStateExpectationScope {
		return new PendingStateExpectationScopeImpl(pendingState, this.record);
	}

	public expectSummary(summary: string): SummaryExpectationScope {
		return new SummaryExpectationScopeImpl(summary, this.record);
	}

	public expectDataStore(client: ClientName, dataStore: string): DataStoreExpectationScope {
		return new DataStoreExpectationScopeImpl(client, dataStore, this.record);
	}

	public expectSnapshotFetch(client: ClientName): SnapshotFetchExpectationScope {
		return new SnapshotFetchExpectationScopeImpl(client, this.record);
	}

	public expectSequence(client: ClientName): SequenceExpectationScope {
		return new SequenceExpectationScopeImpl(client, this.record);
	}

	public note(text: string): void {
		this.record({ kind: "note", text });
	}
}

class ClientActionsImpl implements ClientActions {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public createDetached(): void {
		this.command({ kind: "createDetached", client: this.client });
	}

	public serialize(snapshot: string): void {
		this.command({ kind: "serializeContainer", client: this.client, snapshot });
	}

	public beginAttach(): void {
		this.command({ kind: "beginAttach", client: this.client });
	}

	public attach(): void {
		this.command({ kind: "attach", client: this.client });
	}

	public load(options: LoadOptions): void {
		this.command({ kind: "load", client: this.client, options });
	}

	public connect(): void {
		this.command({ kind: "connect", client: this.client });
	}

	public disconnect(): void {
		this.command({ kind: "disconnect", client: this.client });
	}

	public close(): void {
		this.command({ kind: "close", client: this.client });
	}

	public createDataStore(dataStore: string): void {
		this.command({ kind: "createDataStore", client: this.client, dataStore });
	}

	public makeDataStoreVisible(dataStore: string): void {
		this.command({ kind: "makeDataStoreVisible", client: this.client, dataStore });
	}

	public realizeDataStore(dataStore: string): void {
		this.command({ kind: "realizeDataStore", client: this.client, dataStore });
	}

	public submitOperation(operation: DataStoreOperation): void {
		this.command({ kind: "submitOperation", client: this.client, operation });
	}

	public submitBatch(batch: BatchDefinition): void {
		this.command({ kind: "submitBatch", client: this.client, batch });
	}

	public capturePendingState(pendingState: string): void {
		this.command({ kind: "capturePendingState", client: this.client, pendingState });
	}

	public requestLatestSnapshotRefresh(snapshot?: string): void {
		this.command({
			kind: "requestLatestSnapshotRefresh",
			client: this.client,
			...(snapshot === undefined ? {} : { snapshot }),
		});
	}

	public summarize(options: {
		readonly id: string;
		readonly fullTree?: boolean;
		readonly trackState?: boolean;
	}): void {
		this.command({
			kind: "summarize",
			client: this.client,
			summary: options.id,
			...(options.fullTree === undefined ? {} : { fullTree: options.fullTree }),
			...(options.trackState === undefined ? {} : { trackState: options.trackState }),
		});
	}

	private command(command: Extract<ScenarioStep, { kind: "command" }>["command"]): void {
		this.record({ kind: "command", command });
	}
}

class ProcessingActionsImpl implements ProcessingActions {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public pause(queue: ProcessingQueue): void {
		this.record({
			kind: "command",
			command: { kind: "pauseProcessing", client: this.client, queue },
		});
	}

	public resume(queue: ProcessingQueue): void {
		this.record({
			kind: "command",
			command: { kind: "resumeProcessing", client: this.client, queue },
		});
	}
}

class ServiceActionsImpl<ClientName extends string> implements ServiceActions<ClientName> {
	public constructor(private readonly record: StepRecorder) {}

	public synchronize(...clients: readonly ClientName[]): void {
		this.record({
			kind: "command",
			command: { kind: "synchronize", clients },
		});
	}

	public captureFullContainerState(pendingState: string): void {
		this.record({
			kind: "command",
			command: { kind: "captureFullContainerState", pendingState },
		});
	}

	public completeAttach(client: ClientName): void {
		this.record({
			kind: "command",
			command: { kind: "completeAttach", client },
		});
	}

	public acknowledgeSummary(summary: string, snapshot: string): void {
		this.record({
			kind: "command",
			command: { kind: "acknowledgeSummary", summary, snapshot },
		});
	}

	public nackSummary(summary: string, retryAfterSeconds?: number): void {
		this.record({
			kind: "command",
			command: {
				kind: "nackSummary",
				summary,
				...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
			},
		});
	}
}

class ClientExpectationScopeImpl implements ClientExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(state: ClientStateExpectation["state"]): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "clientState", client: this.client, state },
		});
	}
}

class OperationExpectationTargetImpl<ClientName extends string>
	implements OperationExpectationTarget<ClientName>
{
	public constructor(
		private readonly operation: string,
		private readonly record: StepRecorder,
	) {}

	public at(client: ClientName): OperationExpectationScope {
		return new OperationExpectationScopeImpl(this.operation, client, this.record);
	}
}

class OperationExpectationScopeImpl implements OperationExpectationScope {
	public constructor(
		private readonly operation: string,
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(state: OperationDeliveryState): void {
		this.record({
			kind: "expectation",
			expectation: {
				kind: "operation",
				operation: this.operation,
				client: this.client,
				state,
			},
		});
	}
}

class BatchExpectationScopeImpl implements BatchExpectationScope {
	public constructor(
		private readonly batch: string,
		private readonly record: StepRecorder,
	) {}

	public toBeVirtualizedAs(options: {
		readonly grouped: boolean;
		readonly compressed: boolean;
		readonly chunked: boolean;
		readonly originalOperationCount?: number;
	}): void {
		this.record({
			kind: "expectation",
			expectation: {
				kind: "batchVirtualization",
				batch: this.batch,
				...options,
			},
		});
	}
}

class PendingReplayExpectationScopeImpl implements PendingReplayExpectationScope {
	public constructor(private readonly record: StepRecorder) {}

	public toPreserve(options: {
		readonly batches: readonly string[];
		readonly rebasedBatches?: readonly string[];
	}): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "pendingReplay", ...options },
		});
	}
}

class PendingStateExpectationScopeImpl implements PendingStateExpectationScope {
	public constructor(
		private readonly pendingState: string,
		private readonly record: StepRecorder,
	) {}

	public toContain(state: Omit<PendingStateExpectation, "kind" | "pendingState">): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "pendingState", pendingState: this.pendingState, ...state },
		});
	}
}

class SummaryExpectationScopeImpl implements SummaryExpectationScope {
	public constructor(
		private readonly summary: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(
		state: SummaryState,
		options: Omit<SummaryExpectation, "kind" | "summary" | "state"> = {},
	): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "summary", summary: this.summary, state, ...options },
		});
	}
}

class DataStoreExpectationScopeImpl implements DataStoreExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly dataStore: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(
		realization: "unloaded" | "loaded",
		options: { readonly containsOperations?: readonly string[] } = {},
	): void {
		this.record({
			kind: "expectation",
			expectation: {
				kind: "dataStore",
				client: this.client,
				dataStore: this.dataStore,
				realization,
				...options,
			},
		});
	}
}

class SnapshotFetchExpectationScopeImpl implements SnapshotFetchExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(state: Omit<SnapshotFetchExpectation, "kind" | "client">): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "snapshotFetch", client: this.client, ...state },
		});
	}
}

class SequenceExpectationScopeImpl implements SequenceExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(state: Omit<SequencePositionExpectation, "kind" | "client">): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "sequencePosition", client: this.client, ...state },
		});
	}
}
