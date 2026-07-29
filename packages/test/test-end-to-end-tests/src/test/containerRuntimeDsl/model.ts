/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

export const fluidScenarioFormatVersion = 1 as const;

export type ClientRole = "interactive" | "summarizer";
export type FlushMode = "turnBased" | "immediate";
export type ProcessingQueue = "inbound" | "outbound";
export type AttachState = "detached" | "attaching" | "attached";
export type ConnectionState =
	| "disconnected"
	| "establishingConnection"
	| "catchingUp"
	| "connected";
export type ConnectionEnvironment = "none" | "service" | "frozen";
export type DirtyState = "dirty" | "saved";
export type OperationDeliveryState =
	| "pending"
	| "sequenced"
	| "processed"
	| "acked"
	| "notProcessed";
export type SummaryState = "local" | "broadcast" | "acked" | "nacked";
export type SummaryStage = "base" | "generate" | "upload" | "submit";
export type SummaryObjectForm = "tree" | "handle" | "omitted";
export type CapturedContainerStateKind = "pendingLocalState" | "fullContainerState";
export type DataStoreRealizationState = "unloaded" | "loaded";
export type SnapshotFetchPurpose = "initialLoad" | "summaryAck" | "refresh" | "loadingGroup";

export type ScenarioCoverage =
	| "container-lifecycle"
	| "container-load"
	| "driver-contracts"
	| "op-stream"
	| "op-virtualization"
	| "pending-state"
	| "snapshot"
	| "summarization"
	| "data-virtualization";

export interface ScenarioSource {
	readonly file: string;
	readonly suite: string;
	readonly test: string;
	readonly lines?: string;
}

export interface ClientDefinition<Name extends string = string> {
	readonly id: Name;
	readonly role: ClientRole;
}

export interface DataStoreDefinition {
	readonly id: string;
	readonly root?: boolean;
	readonly loadingGroupId?: string;
	/**
	 * False means the scenario must create and make the DataStore visible before use.
	 */
	readonly initiallyVisible?: boolean;
}

export interface CompressionConfiguration {
	readonly algorithm: "lz4";
	readonly minimumBatchSizeInBytes: number;
}

export interface RuntimeConfiguration {
	readonly flushMode?: FlushMode;
	readonly enableGroupedBatching?: boolean;
	readonly compression?: CompressionConfiguration;
	readonly chunkSizeInBytes?: number;
	readonly enableBatchIdTracking?: boolean;
	readonly enableOfflineFull?: boolean;
	readonly enableDataVirtualization?: boolean;
}

export interface DocumentDefinition {
	readonly id: string;
	readonly runtime?: RuntimeConfiguration;
	readonly dataStores: readonly DataStoreDefinition[];
}

export interface DataStoreOperation {
	readonly id: string;
	readonly dataStore: string;
	/**
	 * Approximate serialized size. The payload remains opaque at the DataStore/DDS boundary.
	 */
	readonly sizeInBytes?: number;
	readonly label?: string;
}

export interface BatchDefinition {
	readonly id: string;
	readonly operations: readonly DataStoreOperation[];
	readonly flushMode?: FlushMode;
	readonly reentrant?: boolean;
}

export interface ServiceLoadSource {
	readonly kind: "service";
	readonly snapshot?: string;
}

export interface PendingStateLoadSource {
	readonly kind: "pendingState";
	readonly pendingState: string;
	readonly mode: "online" | "frozen";
	readonly readOnly?: boolean;
}

export interface SerializedContainerLoadSource {
	readonly kind: "serializedContainer";
	readonly snapshot: string;
}

export type LoadSource =
	| ServiceLoadSource
	| PendingStateLoadSource
	| SerializedContainerLoadSource;

export interface LoadOptions {
	readonly from: LoadSource;
	readonly deltaConnection?: "default" | "none";
	readonly requestedConnectionMode?: "read" | "write";
	readonly pauseAt?: {
		readonly kind: "summaryReferenceSequence";
		readonly summary: string;
	};
}

export interface CreateDetachedCommand {
	readonly kind: "createDetached";
	readonly client: string;
}

export interface SerializeContainerCommand {
	readonly kind: "serializeContainer";
	readonly client: string;
	readonly snapshot: string;
}

export interface BeginAttachCommand {
	readonly kind: "beginAttach";
	readonly client: string;
}

export interface AttachCommand {
	readonly kind: "attach";
	readonly client: string;
}

export interface CompleteAttachCommand {
	readonly kind: "completeAttach";
	readonly client: string;
}

export interface LoadCommand {
	readonly kind: "load";
	readonly client: string;
	readonly options: LoadOptions;
}

export interface ConnectCommand {
	readonly kind: "connect";
	readonly client: string;
}

export interface DisconnectCommand {
	readonly kind: "disconnect";
	readonly client: string;
}

export interface CloseCommand {
	readonly kind: "close";
	readonly client: string;
}

export interface CreateDataStoreCommand {
	readonly kind: "createDataStore";
	readonly client: string;
	readonly dataStore: string;
}

export interface MakeDataStoreVisibleCommand {
	readonly kind: "makeDataStoreVisible";
	readonly client: string;
	readonly dataStore: string;
}

export interface RealizeDataStoreCommand {
	readonly kind: "realizeDataStore";
	readonly client: string;
	readonly dataStore: string;
}

export interface SubmitOperationCommand {
	readonly kind: "submitOperation";
	readonly client: string;
	readonly operation: DataStoreOperation;
}

export interface SubmitBatchCommand {
	readonly kind: "submitBatch";
	readonly client: string;
	readonly batch: BatchDefinition;
}

export interface PauseProcessingCommand {
	readonly kind: "pauseProcessing";
	readonly client: string;
	readonly queue: ProcessingQueue;
}

export interface ResumeProcessingCommand {
	readonly kind: "resumeProcessing";
	readonly client: string;
	readonly queue: ProcessingQueue;
}

export interface SynchronizeCommand {
	readonly kind: "synchronize";
	readonly clients: readonly string[];
}

export interface CapturePendingStateCommand {
	readonly kind: "capturePendingState";
	readonly client: string;
	readonly pendingState: string;
}

export interface CaptureFullContainerStateCommand {
	readonly kind: "captureFullContainerState";
	readonly pendingState: string;
}

export interface RequestLatestSnapshotRefreshCommand {
	readonly kind: "requestLatestSnapshotRefresh";
	readonly client: string;
	readonly snapshot?: string;
}

export interface SummarizeCommand {
	readonly kind: "summarize";
	readonly client: string;
	readonly summary: string;
	readonly fullTree?: boolean;
	readonly trackState?: boolean;
}

export interface AcknowledgeSummaryCommand {
	readonly kind: "acknowledgeSummary";
	readonly summary: string;
	readonly snapshot: string;
}

export interface NackSummaryCommand {
	readonly kind: "nackSummary";
	readonly summary: string;
	readonly retryAfterSeconds?: number;
}

export type ScenarioCommand =
	| CreateDetachedCommand
	| SerializeContainerCommand
	| BeginAttachCommand
	| AttachCommand
	| CompleteAttachCommand
	| LoadCommand
	| ConnectCommand
	| DisconnectCommand
	| CloseCommand
	| CreateDataStoreCommand
	| MakeDataStoreVisibleCommand
	| RealizeDataStoreCommand
	| SubmitOperationCommand
	| SubmitBatchCommand
	| PauseProcessingCommand
	| ResumeProcessingCommand
	| SynchronizeCommand
	| CapturePendingStateCommand
	| CaptureFullContainerStateCommand
	| RequestLatestSnapshotRefreshCommand
	| SummarizeCommand
	| AcknowledgeSummaryCommand
	| NackSummaryCommand;

export interface ClientStateExpectation {
	readonly kind: "clientState";
	readonly client: string;
	readonly state: {
		readonly attach?: AttachState;
		readonly connection?: ConnectionState;
		readonly connectionMode?: "read" | "write";
		readonly readonly?: boolean;
		readonly environment?: ConnectionEnvironment;
		readonly dirty?: DirtyState;
		readonly closed?: boolean;
		readonly inbound?: "running" | "paused";
		readonly outbound?: "running" | "paused";
	};
}

export interface OperationExpectation {
	readonly kind: "operation";
	readonly operation: string;
	readonly client: string;
	readonly state: OperationDeliveryState;
}

export interface BatchVirtualizationExpectation {
	readonly kind: "batchVirtualization";
	readonly batch: string;
	readonly grouped: boolean;
	readonly compressed: boolean;
	readonly chunked: boolean;
	readonly originalOperationCount?: number;
}

export interface PendingReplayExpectation {
	readonly kind: "pendingReplay";
	readonly batches: readonly string[];
	readonly rebasedBatches?: readonly string[];
}

export interface PendingStateExpectation {
	readonly kind: "pendingState";
	readonly pendingState: string;
	readonly captureKind?: CapturedContainerStateKind;
	readonly savedOps?: number;
	readonly stashedOps?: number;
	readonly containsOperations?: readonly string[];
	readonly selfContained?: boolean;
}

export interface SummaryExpectation {
	readonly kind: "summary";
	readonly summary: string;
	readonly state: SummaryState;
	readonly stage?: SummaryStage;
	readonly dataStores?: Readonly<Record<string, SummaryObjectForm>>;
}

export interface DataStoreExpectation {
	readonly kind: "dataStore";
	readonly client: string;
	readonly dataStore: string;
	readonly realization: DataStoreRealizationState;
	readonly containsOperations?: readonly string[];
}

export interface SnapshotFetchExpectation {
	readonly kind: "snapshotFetch";
	readonly client: string;
	readonly purpose: SnapshotFetchPurpose;
	readonly count: number;
	readonly loadingGroupId?: string;
	readonly snapshot?: string;
}

export interface SequencePositionExpectation {
	readonly kind: "sequencePosition";
	readonly client: string;
	readonly initial?: {
		readonly relation: "equal" | "after";
		readonly summary: string;
	};
	readonly last?: {
		readonly relation: "equal" | "after";
		readonly summary: string;
	};
}

export type ScenarioExpectation =
	| ClientStateExpectation
	| OperationExpectation
	| BatchVirtualizationExpectation
	| PendingReplayExpectation
	| PendingStateExpectation
	| SummaryExpectation
	| DataStoreExpectation
	| SnapshotFetchExpectation
	| SequencePositionExpectation;

export type ScenarioStep =
	| {
			readonly kind: "command";
			readonly command: ScenarioCommand;
	  }
	| {
			readonly kind: "expectation";
			readonly expectation: ScenarioExpectation;
	  }
	| {
			readonly kind: "note";
			readonly text: string;
	  };

export interface FluidScenario<ClientName extends string = string> {
	readonly formatVersion: typeof fluidScenarioFormatVersion;
	readonly name: string;
	readonly source: ScenarioSource;
	readonly document: DocumentDefinition;
	readonly clients: readonly ClientDefinition<ClientName>[];
	readonly coverage: readonly ScenarioCoverage[];
	readonly steps: readonly ScenarioStep[];
}
