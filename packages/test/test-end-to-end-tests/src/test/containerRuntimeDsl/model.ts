/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * Version 2 introduces the sequenced trace: submission, sequencing, and per-client
 * processing became three separate concepts instead of one implicit statement order.
 */
export const fluidScenarioFormatVersion = 2 as const;

//* CPLT can we import these consts from FF packages?
export type ClientRole = "interactive" | "summarizer";
export type FlushMode = "turnBased" | "immediate";
export type ProcessingQueue = "inbound" | "outbound";
export type AttachState = "detached" | "attaching" | "attached";
export type ConnectionState = "disconnected" | "connected";
export type ConnectionEnvironment = "none" | "service";
export type DirtyState = "dirty" | "saved";

/**
 * A logical operation's status relative to one client.
 *
 * These states are mutually exclusive:
 *
 * - `pending`: this client has an outstanding local submission.
 * - `sequenced`: it occupies a position in the total order that this client has not reached.
 * - `processed`: this client has advanced through another client's sequenced operation.
 * - `acked`: this client has advanced through its own sequenced operation.
 * - `notProcessed`: it is neither pending here nor present in the sequenced trace.
 */
export type OperationDeliveryState =
	| "pending"
	| "sequenced"
	| "processed"
	| "acked"
	| "notProcessed";
export type SummaryState = "local" | "broadcast" | "acked" | "nacked";
export type SummaryObjectForm = "tree" | "handle";
export type DataStoreRealizationState = "unloaded" | "loaded";

export type ScenarioCoverage =
	| "container-lifecycle"
	| "container-load"
	| "op-stream"
	| "op-ordering"
	| "op-virtualization"
	| "pending-state"
	| "replay"
	| "snapshot"
	| "summarization";

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
}

// ---------------------------------------------------------------------------
// Sequenced trace
// ---------------------------------------------------------------------------

/**
 * A symbolic position in the total order.
 *
 * A scenario never writes raw sequence numbers. It names the sequenced entries it cares
 * about and refers to those names. Two names are reserved: {@link baselineSequenceRef}
 * denotes the position before the first sequenced entry, and {@link latestSequenceRef}
 * denotes the newest sequenced entry at the point the reference is evaluated.
 */
export type SequenceRef = string;

export const baselineSequenceRef = "baseline";
export const latestSequenceRef = "latest";
export const reservedSequenceRefs: readonly SequenceRef[] = [
	baselineSequenceRef,
	latestSequenceRef,
];

/**
 * Where a wire message sits inside a logical batch, mirroring the `batch: true|false`
 * metadata that marks the first and last message of a multi-message batch.
 */
export type BatchPosition = "single" | "start" | "continuation" | "end";

/**
 * The relationship between a logical operation and the wire message that carries it.
 *
 * `grouped` means the whole batch travels as one sequenced message. `chunk` means one
 * payload was split across `count` sequenced messages, and only the message whose
 * `index` equals `count` reconstructs the payload.
 */
export interface WireVirtualization {
	readonly grouped?: boolean;
	readonly compressed?: boolean;
	readonly chunk?: {
		readonly index: number;
		readonly count: number;
	};
}

interface TraceEntryBase {
	/**
	 * Unique symbolic name of this position in the total order.
	 */
	readonly at: string;
	/**
	 * Per-connection submission ordinal. Omit unless the scenario asserts something about it.
	 */
	readonly clientSequence?: number;
	/**
	 * The submitter's processing position when it produced this message. Defaults to the
	 * submitter's cursor at submission time.
	 */
	readonly referenceSequence?: SequenceRef;
}

export interface OperationsTraceEntry extends TraceEntryBase {
	readonly kind: "operations";
	readonly client: string;
	/**
	 * Logical operations reconstructed from this wire message. A non-final chunk carries none.
	 */
	readonly operations: readonly string[];
	readonly batch?: string;
	readonly batchPosition?: BatchPosition;
	readonly virtualization?: WireVirtualization;
}

export interface SummarizeTraceEntry extends TraceEntryBase {
	readonly kind: "summarize";
	readonly client: string;
	readonly summary: string;
}

export interface SummaryAckTraceEntry extends TraceEntryBase {
	readonly kind: "summaryAck";
	readonly summary: string;
	readonly snapshot: string;
}

export interface SummaryNackTraceEntry extends TraceEntryBase {
	readonly kind: "summaryNack";
	readonly summary: string;
	readonly retryAfterSeconds?: number;
}

export type TraceEntry =
	| OperationsTraceEntry
	| SummarizeTraceEntry
	| SummaryAckTraceEntry
	| SummaryNackTraceEntry;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export interface ServiceLoadSource {
	readonly kind: "service";
	readonly snapshot?: string;
}

export interface PendingStateLoadSource {
	readonly kind: "pendingState";
	readonly pendingState: string;
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
	readonly deltaConnection?: "none" | "delayed";
	/**
	 * Pins the container's processing cursor. Delivery past this position is rejected.
	 */
	readonly pauseAt?: SequenceRef;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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

/**
 * Offers a logical operation to the runtime. Submission does not place it in the total
 * order; only a matching {@link SequenceCommand} does.
 */
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

/**
 * Re-offers an already declared logical batch, typically after reconnect or after a
 * rehydrated container replays its pending state under a new client identity.
 */
export interface ResubmitBatchCommand {
	readonly kind: "resubmitBatch";
	readonly client: string;
	readonly batch: string;
}

export type SubmissionCommand =
	| SubmitOperationCommand
	| SubmitBatchCommand
	| ResubmitBatchCommand;

/**
 * Submissions with no relative order. The trace, not the enclosing statement order,
 * decides which one the sequencer accepted first.
 */
export interface ConcurrentSubmissionsCommand {
	readonly kind: "concurrently";
	readonly submissions: readonly SubmissionCommand[];
}

/**
 * Appends one entry to the totally ordered stream of sequenced messages.
 */
export interface SequenceCommand {
	readonly kind: "sequence";
	readonly entry: TraceEntry;
}

/**
 * Advances one client's processing cursor to a position in the total order.
 */
export interface DeliverCommand {
	readonly kind: "deliver";
	readonly client: string;
	readonly through: SequenceRef;
}

/**
 * Advances the listed clients to the newest sequenced position. An empty list means every
 * open, connected, unpinned client.
 */
export interface SynchronizeCommand {
	readonly kind: "synchronize";
	readonly clients: readonly string[];
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

export interface CapturePendingStateCommand {
	readonly kind: "capturePendingState";
	readonly client: string;
	readonly pendingState: string;
}

/**
 * Generates and uploads a summary and submits the summary op. The op only enters the total
 * order when a matching `summarize` trace entry is declared.
 */
export interface SummarizeCommand {
	readonly kind: "summarize";
	readonly client: string;
	readonly summary: string;
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
	| SubmitOperationCommand
	| SubmitBatchCommand
	| ResubmitBatchCommand
	| ConcurrentSubmissionsCommand
	| SequenceCommand
	| DeliverCommand
	| SynchronizeCommand
	| PauseProcessingCommand
	| ResumeProcessingCommand
	| CapturePendingStateCommand
	| SummarizeCommand;

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export interface ClientStateExpectation {
	readonly kind: "clientState";
	readonly client: string;
	readonly state: {
		readonly attach?: AttachState;
		readonly connection?: ConnectionState;
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

/**
 * How many times a client applied a logical operation. Replay scenarios assert `1`.
 */
export interface LogicalApplicationExpectation {
	readonly kind: "logicalApplication";
	readonly operation: string;
	readonly client: string;
	readonly times: number;
}

export interface BatchVirtualizationExpectation {
	readonly kind: "batchVirtualization";
	readonly batch: string;
	readonly grouped: boolean;
	readonly compressed: boolean;
	readonly chunked: boolean;
	readonly originalOperationCount?: number;
	/**
	 * Number of sequenced messages the batch occupied. Grouping drives this down to one;
	 * chunking drives it up.
	 */
	readonly wireMessages?: number;
}

/**
 * The batches one client still has outstanding, in the order its runtime will replay them.
 */
export interface PendingReplayExpectation {
	readonly kind: "pendingReplay";
	readonly client: string;
	readonly batches: readonly string[];
}

export interface PendingStateExpectation {
	readonly kind: "pendingState";
	readonly pendingState: string;
	readonly savedOps?: number;
	readonly stashedOps?: number;
	readonly containsOperations?: readonly string[];
}

export interface SummaryExpectation {
	readonly kind: "summary";
	readonly summary: string;
	readonly state: SummaryState;
	readonly dataStores?: Readonly<Record<string, SummaryObjectForm>>;
}

export interface DataStoreExpectation {
	readonly kind: "dataStore";
	readonly client: string;
	readonly dataStore: string;
	readonly realization: DataStoreRealizationState;
	readonly containsOperations?: readonly string[];
}

export interface SequenceRelation {
	readonly relation: "equal" | "after" | "atLeast";
	readonly position: SequenceRef;
}

/**
 * Where a client sits in the total order: where it started, and how far it has processed.
 */
export interface DeliveryExpectation {
	readonly kind: "delivery";
	readonly client: string;
	readonly loadedAt?: SequenceRelation;
	readonly processedThrough?: SequenceRelation;
}

/**
 * Asserts that one sequenced position strictly precedes another. This is how a scenario
 * states an intentional interleaving without relying on statement order.
 */
export interface SequenceOrderExpectation {
	readonly kind: "sequenceOrder";
	readonly before: SequenceRef;
	readonly after: SequenceRef;
}

/**
 * Every listed client processed the same positions and applied the same logical operations.
 */
export interface ConvergenceExpectation {
	readonly kind: "convergence";
	readonly clients: readonly string[];
}

/**
 * Checkable properties of the declared trace.
 *
 * `denseTotalOrder`: positions are unique and every declared reference resolves.
 *
 * `clientSequenceMonotonic`: explicit client sequence numbers increase within a connection.
 *
 * `batchContiguity`: a batch's wire messages are contiguous, from one client, at one reference
 * sequence number, with well-formed batch begin/end markers.
 *
 * `causalReferenceSequence`: a message's reference sequence number is a position its submitter
 * had already processed, and precedes the message's own position.
 *
 * `wireReconstruction`: chunked payloads are either fully reconstructed or abandoned by a
 * submitter that lost its connection.
 *
 * `exactlyOnceApplication`: a logical operation occupies one position in the total order, and
 * no client applies it twice.
 *
 * `orderedDelivery`: cursors only move forward, and never past a pinned position.
 */
export type TraceInvariant =
	| "denseTotalOrder"
	| "clientSequenceMonotonic"
	| "batchContiguity"
	| "causalReferenceSequence"
	| "wireReconstruction"
	| "exactlyOnceApplication"
	| "orderedDelivery";

export const allTraceInvariants: readonly TraceInvariant[] = [
	"denseTotalOrder",
	"clientSequenceMonotonic",
	"batchContiguity",
	"causalReferenceSequence",
	"wireReconstruction",
	"exactlyOnceApplication",
	"orderedDelivery",
];

export interface TraceInvariantExpectation {
	readonly kind: "traceInvariants";
	readonly invariants: readonly TraceInvariant[];
}

export type ScenarioExpectation =
	| ClientStateExpectation
	| OperationExpectation
	| LogicalApplicationExpectation
	| BatchVirtualizationExpectation
	| PendingReplayExpectation
	| PendingStateExpectation
	| SummaryExpectation
	| DataStoreExpectation
	| DeliveryExpectation
	| SequenceOrderExpectation
	| ConvergenceExpectation
	| TraceInvariantExpectation;

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
