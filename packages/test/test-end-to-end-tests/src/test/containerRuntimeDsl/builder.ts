/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	type BatchDefinition,
	type BatchPosition,
	type ClientDefinition,
	type ClientStateExpectation,
	type DataStoreDefinition,
	type DataStoreOperation,
	type DeliveryExpectation,
	type DocumentDefinition,
	type FluidScenario,
	type LoadOptions,
	type OperationDeliveryState,
	type PendingStateExpectation,
	type ProcessingQueue,
	type RuntimeConfiguration,
	type ScenarioCoverage,
	type ScenarioSource,
	type OperationBunch,
	type ScenarioStep,
	type SequenceRef,
	type SnapshotFetchExpectation,
	type SubmissionCommand,
	type SummaryExpectation,
	type SummaryState,
	type TraceEntry,
	type TraceInvariant,
	type WireVirtualization,
	allTraceInvariants,
	fluidScenarioFormatVersion,
} from "./model.js";

type StepRecorder = (step: ScenarioStep) => void;
type SubmissionRecorder = (command: SubmissionCommand) => void;

export interface ScenarioSourceStage {
	fromTest(source: ScenarioSource): ScenarioDocumentStage;
}

export interface ScenarioDocumentStage {
	document(document: DocumentDefinition): ScenarioClientStage;
}

export interface ScenarioClientStage {
	clients<const Definitions extends readonly [ClientDefinition, ...ClientDefinition[]]>(
		...clients: Definitions
	): ScenarioCoverageStage<Definitions[number]["id"]>;
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
	/**
	 * Submissions with no relative order among themselves.
	 */
	concurrently(define: (block: ConcurrentSubmissions<ClientName>) => void): void;
	processing(client: ClientName): ProcessingActions;
	/**
	 * The abstract sequencer. Every call appends one entry to the total order.
	 */
	sequence(): SequenceActions<ClientName>;
	service(): ServiceActions<ClientName>;
	expectClient(client: ClientName): ClientExpectationScope;
	expectOperation(operation: string): OperationExpectationTarget<ClientName>;
	expectBatch(batch: string): BatchExpectationScope;
	/**
	 * How one sequenced message's operations are split for dispatch.
	 */
	expectBunches(at: SequenceRef): BunchExpectationScope;
	expectPendingReplay(client: ClientName): PendingReplayExpectationScope;
	expectPendingState(pendingState: string): PendingStateExpectationScope;
	expectSummary(summary: string): SummaryExpectationScope;
	expectDataStore(client: ClientName, dataStore: string): DataStoreExpectationScope;
	expectSnapshotFetch(client: ClientName): SnapshotFetchExpectationScope;
	expectDelivery(client: ClientName): DeliveryExpectationScope;
	expectOrder(before: SequenceRef, after: SequenceRef): void;
	expectConvergence(...clients: readonly ClientName[]): void;
	expectTrace(): TraceExpectationScope;
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
	resubmitBatch(options: { readonly batch: string; readonly as?: string }): void;
	capturePendingState(pendingState: string): void;
	requestLatestSnapshotRefresh(snapshot?: string): void;
	summarize(options: {
		readonly id: string;
		readonly fullTree?: boolean;
		readonly trackState?: boolean;
	}): void;
}

export interface ConcurrentSubmissions<ClientName extends string> {
	client(client: ClientName): ConcurrentClientActions;
}

export interface ConcurrentClientActions {
	submitOperation(operation: DataStoreOperation): void;
	submitBatch(batch: BatchDefinition): void;
	resubmitBatch(options: { readonly batch: string; readonly as?: string }): void;
}

export interface ProcessingActions {
	pause(queue: ProcessingQueue): void;
	resume(queue: ProcessingQueue): void;
}

export interface SequencedOperationsOptions {
	readonly batch?: string;
	readonly batchId?: string;
	readonly batchPosition?: BatchPosition;
	readonly virtualization?: WireVirtualization;
	readonly clientSequence?: number;
	readonly referenceSequence?: SequenceRef;
	readonly minimumSequence?: SequenceRef;
	readonly duplicateOf?: string;
}

export interface SequenceActions<ClientName extends string> {
	/**
	 * A wire message carrying one or more reconstructed logical operations.
	 */
	operations(
		at: string,
		from: ClientName,
		operations: readonly string[],
		options?: SequencedOperationsOptions,
	): void;
	/**
	 * A non-final chunk of a split payload. It reconstructs nothing on its own.
	 */
	chunk(
		at: string,
		from: ClientName,
		options: {
			readonly batch: string;
			readonly index: number;
			readonly count: number;
			readonly clientSequence?: number;
			readonly referenceSequence?: SequenceRef;
		},
	): void;
	join(at: string, client: ClientName): void;
	leave(at: string, client: ClientName): void;
	noop(at: string, client?: ClientName): void;
	summarize(at: string, from: ClientName, summary: string): void;
	summaryAck(at: string, summary: string, snapshot: string): void;
	summaryNack(at: string, summary: string, retryAfterSeconds?: number): void;
}

export interface ServiceActions<ClientName extends string> {
	/**
	 * Advances one client's processing cursor.
	 */
	deliver(client: ClientName): DeliveryScope;
	synchronize(...clients: readonly ClientName[]): void;
	captureFullContainerState(pendingState: string): void;
	completeAttach(client: ClientName): void;
}

export interface DeliveryScope {
	through(position: SequenceRef): void;
}

export interface ClientExpectationScope {
	toBe(state: ClientStateExpectation["state"]): void;
}

export interface OperationExpectationTarget<ClientName extends string> {
	at(client: ClientName): OperationExpectationScope;
}

export interface OperationExpectationScope {
	toBe(state: OperationDeliveryState): void;
	toBeAppliedTimes(times: number): void;
}

export interface BatchExpectationScope {
	toBeVirtualizedAs(options: {
		readonly grouped: boolean;
		readonly compressed: boolean;
		readonly chunked: boolean;
		readonly originalOperationCount?: number;
		readonly wireMessages?: number;
	}): void;
}

export interface BunchExpectationScope {
	toBe(bunches: readonly OperationBunch[]): void;
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

export interface DeliveryExpectationScope {
	toBe(state: Omit<DeliveryExpectation, "kind" | "client">): void;
}

export interface TraceExpectationScope {
	/**
	 * Defaults to every invariant the validator knows.
	 */
	toSatisfy(invariants?: readonly TraceInvariant[]): void;
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

	public clients<const Definitions extends readonly [ClientDefinition, ...ClientDefinition[]]>(
		...clients: Definitions
	): ScenarioCoverageStage<Definitions[number]["id"]> {
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

	public concurrently(define: (block: ConcurrentSubmissions<ClientName>) => void): void {
		const submissions: SubmissionCommand[] = [];
		define(new ConcurrentSubmissionsImpl((command) => submissions.push(command)));
		this.record({
			kind: "command",
			command: { kind: "concurrently", submissions },
		});
	}

	public processing(client: ClientName): ProcessingActions {
		return new ProcessingActionsImpl(client, this.record);
	}

	public sequence(): SequenceActions<ClientName> {
		return new SequenceActionsImpl(this.record);
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

	public expectBunches(at: SequenceRef): BunchExpectationScope {
		return new BunchExpectationScopeImpl(at, this.record);
	}

	public expectPendingReplay(client: ClientName): PendingReplayExpectationScope {
		return new PendingReplayExpectationScopeImpl(client, this.record);
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

	public expectDelivery(client: ClientName): DeliveryExpectationScope {
		return new DeliveryExpectationScopeImpl(client, this.record);
	}

	public expectOrder(before: SequenceRef, after: SequenceRef): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "sequenceOrder", before, after },
		});
	}

	public expectConvergence(...clients: readonly ClientName[]): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "convergence", clients },
		});
	}

	public expectTrace(): TraceExpectationScope {
		return new TraceExpectationScopeImpl(this.record);
	}

	public note(text: string): void {
		this.record({ kind: "note", text });
	}
}

class SubmissionActionsImpl {
	public constructor(
		protected readonly client: string,
		private readonly submit: SubmissionRecorder,
	) {}

	public submitOperation(operation: DataStoreOperation): void {
		this.submit({ kind: "submitOperation", client: this.client, operation });
	}

	public submitBatch(batch: BatchDefinition): void {
		this.submit({ kind: "submitBatch", client: this.client, batch });
	}

	public resubmitBatch(options: { readonly batch: string; readonly as?: string }): void {
		this.submit({
			kind: "resubmitBatch",
			client: this.client,
			batch: options.batch,
			...(options.as === undefined ? {} : { batchId: options.as }),
		});
	}
}

class ConcurrentSubmissionsImpl<ClientName extends string>
	implements ConcurrentSubmissions<ClientName>
{
	public constructor(private readonly submit: SubmissionRecorder) {}

	public client(client: ClientName): ConcurrentClientActions {
		return new SubmissionActionsImpl(client, this.submit);
	}
}

class ClientActionsImpl extends SubmissionActionsImpl implements ClientActions {
	public constructor(
		client: string,
		private readonly record: StepRecorder,
	) {
		super(client, (command) => record({ kind: "command", command }));
	}

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

class SequenceActionsImpl<ClientName extends string> implements SequenceActions<ClientName> {
	public constructor(private readonly record: StepRecorder) {}

	public operations(
		at: string,
		from: ClientName,
		operations: readonly string[],
		options: SequencedOperationsOptions = {},
	): void {
		this.entry({
			kind: "operations",
			at,
			client: from,
			operations,
			...options,
		});
	}

	public chunk(
		at: string,
		from: ClientName,
		options: {
			readonly batch: string;
			readonly index: number;
			readonly count: number;
			readonly clientSequence?: number;
			readonly referenceSequence?: SequenceRef;
		},
	): void {
		this.entry({
			kind: "operations",
			at,
			client: from,
			operations: [],
			batch: options.batch,
			virtualization: { chunk: { index: options.index, count: options.count } },
			...(options.clientSequence === undefined
				? {}
				: { clientSequence: options.clientSequence }),
			...(options.referenceSequence === undefined
				? {}
				: { referenceSequence: options.referenceSequence }),
		});
	}

	public join(at: string, client: ClientName): void {
		this.entry({ kind: "join", at, client });
	}

	public leave(at: string, client: ClientName): void {
		this.entry({ kind: "leave", at, client });
	}

	public noop(at: string, client?: ClientName): void {
		this.entry({ kind: "noop", at, ...(client === undefined ? {} : { client }) });
	}

	public summarize(at: string, from: ClientName, summary: string): void {
		this.entry({ kind: "summarize", at, client: from, summary });
	}

	public summaryAck(at: string, summary: string, snapshot: string): void {
		this.entry({ kind: "summaryAck", at, summary, snapshot });
	}

	public summaryNack(at: string, summary: string, retryAfterSeconds?: number): void {
		this.entry({
			kind: "summaryNack",
			at,
			summary,
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		});
	}

	private entry(entry: TraceEntry): void {
		this.record({ kind: "command", command: { kind: "sequence", entry } });
	}
}

class ServiceActionsImpl<ClientName extends string> implements ServiceActions<ClientName> {
	public constructor(private readonly record: StepRecorder) {}

	public deliver(client: ClientName): DeliveryScope {
		return {
			through: (position: SequenceRef): void => {
				this.record({
					kind: "command",
					command: { kind: "deliver", client, through: position },
				});
			},
		};
	}

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

	public toBeAppliedTimes(times: number): void {
		this.record({
			kind: "expectation",
			expectation: {
				kind: "logicalApplication",
				operation: this.operation,
				client: this.client,
				times,
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
		readonly wireMessages?: number;
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

class BunchExpectationScopeImpl implements BunchExpectationScope {
	public constructor(
		private readonly at: SequenceRef,
		private readonly record: StepRecorder,
	) {}

	public toBe(bunches: readonly OperationBunch[]): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "operationBunches", at: this.at, bunches },
		});
	}
}

class PendingReplayExpectationScopeImpl implements PendingReplayExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toPreserve(options: {
		readonly batches: readonly string[];
		readonly rebasedBatches?: readonly string[];
	}): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "pendingReplay", client: this.client, ...options },
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

class DeliveryExpectationScopeImpl implements DeliveryExpectationScope {
	public constructor(
		private readonly client: string,
		private readonly record: StepRecorder,
	) {}

	public toBe(state: Omit<DeliveryExpectation, "kind" | "client">): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "delivery", client: this.client, ...state },
		});
	}
}

class TraceExpectationScopeImpl implements TraceExpectationScope {
	public constructor(private readonly record: StepRecorder) {}

	public toSatisfy(invariants: readonly TraceInvariant[] = allTraceInvariants): void {
		this.record({
			kind: "expectation",
			expectation: { kind: "traceInvariants", invariants },
		});
	}
}
