/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { document, fluidScenario, interactiveClient, summarizerClient } from "./builder.js";
import type { DataStoreOperation, FluidScenario } from "./model.js";

const rootDataStore = { id: "root", root: true } as const;

function op(
	id: string,
	dataStore: string = rootDataStore.id,
	sizeInBytes?: number,
): DataStoreOperation {
	return {
		id,
		dataStore,
		...(sizeInBytes === undefined ? {} : { sizeInBytes }),
	};
}

export const disconnectGatesInboundOps = fluidScenario(
	"disconnect gates inbound operation processing",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/container.spec.ts",
		suite: "Container",
		test: "can control op processing with connect() and disconnect()",
		lines: "374-447",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(interactiveClient("writer"), interactiveClient("reader"))
	.covers("container-lifecycle", "op-stream", "op-ordering")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("reader").load({ from: { kind: "service" } });
		s.note(
			"The reader states its membership explicitly, so it is catching up until its own join message is ordered and processed.",
		);
		s.expectClient("reader").toBe({ connection: "catchingUp" });
		s.sequence().join("seq-reader-join", "reader");
		s.expectClient("reader").toBe({ connection: "connected" });

		s.client("writer").submitOperation(op("initial-value"));
		s.sequence().operations("seq-initial", "writer", ["initial-value"]);
		s.service().synchronize();
		s.expectOperation("initial-value").at("reader").toBe("processed");

		s.client("reader").disconnect();
		s.expectClient("reader").toBe({ connection: "disconnected" });
		s.sequence().leave("seq-reader-leave", "reader");

		s.client("writer").submitOperation(op("value-while-reader-disconnected"));
		s.sequence().operations("seq-while-disconnected", "writer", [
			"value-while-reader-disconnected",
		]);
		s.note(
			"The operation is ordered by the service even though the reader is not there to receive it. Sequencing and per-client processing are different events.",
		);
		s.service().deliver("writer").through("latest");
		s.expectOperation("value-while-reader-disconnected").at("writer").toBe("acked");
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("sequenced");
		s.expectDelivery("reader").toBe({
			processedThrough: { relation: "equal", position: "seq-initial" },
		});

		s.client("reader").connect();
		s.note(
			"Rejoining is catching up: the reader's own join position is the point it has processed through.",
		);
		s.sequence().join("seq-reader-rejoin", "reader");
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("processed");
		s.expectDelivery("reader").toBe({
			processedThrough: { relation: "equal", position: "seq-reader-rejoin" },
		});
		s.service().synchronize();
		s.expectConvergence("writer", "reader");
		s.expectTrace().toSatisfy();
	});

export const pausedLoadAfterSummary = fluidScenario(
	"load remains pinned at the summary's reference position",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/loadModes.spec.ts",
		suite: "LoadModes",
		test: "Can load a paused container after a summary",
		lines: "260-322",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(
		interactiveClient("writer"),
		summarizerClient("summarizer"),
		interactiveClient("paused-reader"),
	)
	.covers("container-load", "snapshot", "summarization", "op-ordering")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });

		const beforeSummary = [0, 1, 2, 3, 4].map((index) => `before-summary-${index}`);
		s.client("writer").submitBatch({
			id: "before-summary",
			operations: beforeSummary.map((id) => op(id)),
		});
		s.note(
			"Grouped batching is off, so the batch occupies five sequenced messages carrying the batch begin/end markers.",
		);
		for (const [index, id] of beforeSummary.entries()) {
			s.sequence().operations(`seq-${id}`, "writer", [id], {
				batch: "before-summary",
				batchPosition:
					index === 0 ? "start" : index === beforeSummary.length - 1 ? "end" : "continuation",
				clientSequence: index + 1,
			});
		}
		s.expectBatch("before-summary").toBeVirtualizedAs({
			grouped: false,
			compressed: false,
			chunked: false,
			originalOperationCount: 5,
			wireMessages: 5,
		});
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.service().synchronize();

		s.client("paused-reader").load({
			from: { kind: "service", snapshot: "snapshot-1" },
			pauseAt: "seq-before-summary-4",
		});
		s.note(
			"The snapshot content corresponds to the summary op's reference position, not to the position of the summary op or its ack.",
		);
		s.expectDelivery("paused-reader").toBe({
			loadedAt: { relation: "equal", position: "seq-before-summary-4" },
			processedThrough: { relation: "equal", position: "seq-before-summary-4" },
		});

		const afterSummary = [0, 1, 2, 3, 4].map((index) => `after-summary-${index}`);
		s.client("writer").submitBatch({
			id: "after-summary",
			operations: afterSummary.map((id) => op(id)),
		});
		for (const [index, id] of afterSummary.entries()) {
			s.sequence().operations(`seq-${id}`, "writer", [id], {
				batch: "after-summary",
				batchPosition:
					index === 0 ? "start" : index === afterSummary.length - 1 ? "end" : "continuation",
			});
		}
		s.service().synchronize("writer");
		for (const id of afterSummary) {
			s.expectOperation(id).at("paused-reader").toBe("sequenced");
			s.expectOperation(id).at("paused-reader").toBeAppliedTimes(0);
		}
		s.expectDelivery("paused-reader").toBe({
			processedThrough: { relation: "equal", position: "seq-before-summary-4" },
		});
		s.expectOrder("seq-summary-ack-1", "seq-after-summary-0");
		s.expectTrace().toSatisfy();
	});

export const virtualizedOperationBatch = fluidScenario(
	"a grouped, compressed batch is reconstructed from three chunk messages",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/compression.spec.ts",
		suite: "Op Compression > Compression",
		test: "Correctly processes messages: compression [true] chunking [true] grouping [true]",
		lines: "131-179",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "turnBased",
			enableGroupedBatching: true,
			compression: {
				algorithm: "lz4",
				minimumBatchSizeInBytes: 10,
			},
			chunkSizeInBytes: 100,
		}),
	)
	.clients(interactiveClient("writer"), interactiveClient("reader"))
	.covers("op-stream", "op-ordering", "op-virtualization")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("reader").load({ from: { kind: "service" } });

		const largeOps = [0, 1, 2].map((index) => `large-op-${index}`);
		s.client("writer").submitBatch({
			id: "large-batch",
			operations: largeOps.map((id) => op(id, rootDataStore.id, 100)),
		});
		s.note(
			"Three logical operations become one grouped payload, one compressed envelope, and three sequenced chunk messages. Only the final chunk reconstructs anything.",
		);
		s.sequence().chunk("seq-chunk-1", "writer", {
			batch: "large-batch",
			index: 1,
			count: 3,
			clientSequence: 1,
		});
		s.sequence().chunk("seq-chunk-2", "writer", {
			batch: "large-batch",
			index: 2,
			count: 3,
			clientSequence: 2,
		});
		s.sequence().operations("seq-chunk-3", "writer", largeOps, {
			batch: "large-batch",
			clientSequence: 3,
			virtualization: {
				grouped: true,
				compressed: true,
				chunk: { index: 3, count: 3 },
			},
		});
		s.expectBatch("large-batch").toBeVirtualizedAs({
			grouped: true,
			compressed: true,
			chunked: true,
			originalOperationCount: 3,
			wireMessages: 3,
		});

		s.service().deliver("reader").through("seq-chunk-2");
		s.note(
			"A reader holding two of three chunks has reconstructed nothing; partial wire state is not partial logical state.",
		);
		for (const id of largeOps) {
			s.expectOperation(id).at("reader").toBe("sequenced");
		}

		s.service().synchronize();
		for (const id of largeOps) {
			s.expectOperation(id).at("writer").toBe("acked");
			s.expectOperation(id).at("reader").toBe("processed");
			s.expectOperation(id).at("reader").toBeAppliedTimes(1);
		}
		s.expectConvergence("writer", "reader");
		s.expectTrace().toSatisfy();
	});

export const pendingBatchReentry = fluidScenario(
	"reentrant pending batches are rebased and replayed in submission order",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/pendingBatchReentry.spec.ts",
		suite: "Op reentry and rebasing during pending batches",
		test: "Pending batches with reentry - SharedCounter",
		lines: "130-180",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "immediate",
			enableGroupedBatching: true,
		}),
	)
	.clients(interactiveClient("writer"))
	.covers("op-stream", "op-ordering", "pending-state", "replay")
	.steps((s) => {
		s.client("writer").load({
			from: { kind: "service" },
			requestedConnectionMode: "read",
		});
		s.client("writer").submitBatch({
			id: "initial-batch",
			operations: [op("initial-op")],
		});
		s.client("writer").submitBatch({
			id: "reentrant-batch",
			operations: [op("reentrant-op")],
			reentrant: true,
		});
		s.note(
			"A read connection cannot place anything in the total order, so both batches stay pending and take effect only locally.",
		);
		s.expectOperation("initial-op").at("writer").toBe("pending");
		s.expectOperation("reentrant-op").at("writer").toBe("pending");
		s.expectPendingReplay("writer").toPreserve({
			batches: ["initial-batch", "reentrant-batch"],
			rebasedBatches: ["reentrant-batch"],
		});

		s.client("writer").connect();
		s.sequence().operations("seq-initial", "writer", ["initial-op"], {
			batch: "initial-batch",
			batchPosition: "single",
			clientSequence: 1,
			virtualization: { grouped: true },
		});
		s.sequence().operations("seq-reentrant", "writer", ["reentrant-op"], {
			batch: "reentrant-batch",
			batchPosition: "single",
			clientSequence: 2,
			virtualization: { grouped: true },
		});
		s.expectOrder("seq-initial", "seq-reentrant");

		s.service().synchronize();
		s.expectOperation("initial-op").at("writer").toBe("acked");
		s.expectOperation("reentrant-op").at("writer").toBe("acked");
		s.expectOperation("initial-op").at("writer").toBeAppliedTimes(1);
		s.expectOperation("reentrant-op").at("writer").toBeAppliedTimes(1);
		s.expectTrace().toSatisfy();
	});

export const stashedOpsWithoutSavedOps = fluidScenario(
	"rehydrate stashed operations based directly on a summary",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/offline/waitForSummary.spec.ts",
		suite: "Offline tests that wait for a summary",
		test: "applies stashed ops with no saved ops (map)",
		lines: "243-285",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "turnBased",
			enableGroupedBatching: true,
		}),
	)
	.clients(
		interactiveClient("original"),
		summarizerClient("summarizer"),
		interactiveClient("stashing-client"),
		interactiveClient("resumed"),
	)
	.covers(
		"container-load",
		"op-ordering",
		"pending-state",
		"replay",
		"snapshot",
		"summarization",
	)
	.steps((s) => {
		s.client("original").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("summarizer").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.service().synchronize();

		s.client("stashing-client").load({
			from: { kind: "service", snapshot: "snapshot-1" },
			deltaConnection: "none",
		});
		s.client("stashing-client").submitBatch({
			id: "stashed-batch",
			operations: [op("stashed-op")],
		});
		s.client("stashing-client").capturePendingState("stash-without-saved-ops");
		s.note(
			"The container never processed anything past its base snapshot, so the capture holds no saved ops and exactly one unsequenced local op.",
		);
		s.expectPendingState("stash-without-saved-ops").toContain({
			captureKind: "pendingLocalState",
			savedOps: 0,
			stashedOps: 1,
			containsOperations: ["stashed-op"],
		});
		s.client("stashing-client").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "stash-without-saved-ops",
				mode: "online",
			},
		});
		s.client("resumed").resubmitBatch({ batch: "stashed-batch", as: "stashed-batch-id" });
		s.note(
			"The replay carries a new client identity but the original batch identity, so the logical operation keeps one identity across two sessions.",
		);
		s.sequence().operations("seq-stashed", "resumed", ["stashed-op"], {
			batch: "stashed-batch",
			batchPosition: "single",
			batchId: "stashed-batch-id",
			clientSequence: 1,
			virtualization: { grouped: true },
		});
		s.service().synchronize();
		s.expectOperation("stashed-op").at("original").toBe("processed");
		s.expectOperation("stashed-op").at("resumed").toBe("acked");
		s.expectOperation("stashed-op").at("resumed").toBeAppliedTimes(1);
		s.expectOperation("stashed-op").at("original").toBeAppliedTimes(1);
		s.expectConvergence("original", "resumed");
		s.expectTrace().toSatisfy();
	});

export const frozenOfflineRoundTrip = fluidScenario(
	"full capture supports writable frozen load and online resume",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/offline/frozenOfflineRoundTrip.spec.ts",
		suite: "frozen container offline round-trip",
		test: "captureFullContainerState → offline writable load → re-capture → online resume",
		lines: "102-170",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "turnBased",
			enableGroupedBatching: true,
			enableOfflineFull: true,
		}),
	)
	.clients(
		interactiveClient("original"),
		interactiveClient("offline"),
		interactiveClient("resumed"),
	)
	.covers("container-load", "op-ordering", "pending-state", "replay", "snapshot")
	.steps((s) => {
		s.client("original").load({ from: { kind: "service" } });
		s.service().captureFullContainerState("full-container-state");
		s.expectPendingState("full-container-state").toContain({
			captureKind: "fullContainerState",
			selfContained: true,
		});

		s.client("offline").load({
			from: {
				kind: "pendingState",
				pendingState: "full-container-state",
				mode: "frozen",
				readOnly: false,
			},
		});
		s.expectClient("offline").toBe({
			attach: "attached",
			connection: "connected",
			environment: "frozen",
			readonly: false,
		});

		const offlineOps = [0, 1, 2, 3, 4].map((index) => `offline-${index}`);
		s.client("offline").submitBatch({
			id: "offline-edits",
			operations: offlineOps.map((id) => op(id)),
		});
		s.note(
			"A frozen container has no path to the sequencer, so these operations can take effect locally but can never reach the total order from this session.",
		);
		for (const id of offlineOps) {
			s.expectOperation(id).at("offline").toBe("pending");
		}
		s.client("offline").capturePendingState("layered-pending-state");
		s.expectPendingState("layered-pending-state").toContain({
			captureKind: "pendingLocalState",
			savedOps: 0,
			stashedOps: 5,
			containsOperations: offlineOps,
		});
		s.client("offline").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "layered-pending-state",
				mode: "online",
			},
		});
		s.client("resumed").resubmitBatch({ batch: "offline-edits", as: "offline-edits-id" });
		s.sequence().operations("seq-offline-edits", "resumed", offlineOps, {
			batch: "offline-edits",
			batchPosition: "single",
			batchId: "offline-edits-id",
			clientSequence: 1,
			virtualization: { grouped: true },
		});
		s.expectBatch("offline-edits").toBeVirtualizedAs({
			grouped: true,
			compressed: false,
			chunked: false,
			originalOperationCount: 5,
			wireMessages: 1,
		});
		s.service().synchronize();
		for (const id of offlineOps) {
			s.expectOperation(id).at("original").toBe("processed");
			s.expectOperation(id).at("resumed").toBe("acked");
			s.expectOperation(id).at("original").toBeAppliedTimes(1);
			s.expectOperation(id).at("resumed").toBeAppliedTimes(1);
		}
		s.expectConvergence("original", "resumed");
		s.expectTrace().toSatisfy();
	});

export const oldSummarizerFetchesLatestSnapshot = fluidScenario(
	"older summarizer refreshes when it processes the newer summary ack",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/summarization/summarizationFetchValidation.spec.ts",
		suite: "Summarizer fetches expected number of times",
		test: "Summarizer loading from an older summary should fetch latest summary",
		lines: "169-213",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(
		interactiveClient("main"),
		summarizerClient("summarizer-1"),
		summarizerClient("summarizer-2"),
	)
	.covers("driver-contracts", "op-ordering", "snapshot", "summarization")
	.steps((s) => {
		s.client("main").load({ from: { kind: "service" } });
		s.client("summarizer-1").load({ from: { kind: "service" } });
		s.client("summarizer-2").load({ from: { kind: "service" } });

		s.client("main").submitOperation(op("before-summary"));
		s.sequence().operations("seq-before-summary", "main", ["before-summary"]);
		s.service().synchronize();

		s.client("summarizer-1").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer-1", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.expectSummary("summary-1").toBe("acked", { stage: "submit" });
		s.note(
			"Summary op, ack, and DataStore ops share one total order. The ack is a sequenced message, not an out-of-band service callback.",
		);

		s.client("main").submitOperation(op("ack-processing-trigger"));
		s.sequence().operations("seq-ack-trigger", "main", ["ack-processing-trigger"]);
		s.expectOrder("seq-summary-ack-1", "seq-ack-trigger");
		s.note(
			"The trailing operation exists only to pull each summarizer's processing cursor past the ack; without it the fetch would never be triggered.",
		);
		s.service().synchronize();
		s.expectDelivery("summarizer-2").toBe({
			processedThrough: { relation: "after", position: "seq-summary-ack-1" },
		});
		s.expectSnapshotFetch("summarizer-2").toBe({
			purpose: "summaryAck",
			count: 1,
			snapshot: "snapshot-1",
		});
		s.expectTrace().toSatisfy();
	});

export const detachedSerializeAndRehydrate = fluidScenario(
	"serialize and rehydrate a detached container before attach",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/deRehydrateContainerTests.spec.ts",
		suite: "Dehydrate Rehydrate Container Test",
		test: "Rehydrate container from snapshot and check contents before attach",
		lines: "441-478",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(interactiveClient("detached"), interactiveClient("rehydrated"))
	.covers("container-lifecycle", "container-load", "snapshot")
	.steps((s) => {
		s.client("detached").createDetached();
		s.client("detached").serialize("serialized-detached-container");
		s.client("rehydrated").load({
			from: {
				kind: "serializedContainer",
				snapshot: "serialized-detached-container",
			},
		});
		s.note(
			"No document exists yet, so the total order is empty and both containers sit at the baseline position.",
		);
		s.expectClient("rehydrated").toBe({
			attach: "detached",
			connection: "disconnected",
			environment: "none",
		});
		s.expectDelivery("rehydrated").toBe({
			loadedAt: { relation: "equal", position: "baseline" },
			processedThrough: { relation: "equal", position: "baseline" },
		});
		s.expectDataStore("rehydrated", rootDataStore.id).toBe("loaded");
	});

export const incrementalDataStoreSummaries = fluidScenario(
	"incremental summaries use handles only for unchanged DataStores",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/summarization/summarizeIncrementally.spec.ts",
		suite: "Incremental summaries for data store and DDS",
		test: "can do incremental data store summary",
		lines: "136-184",
	})
	.document(
		document("collaboration", [rootDataStore, { id: "secondary", initiallyVisible: false }]),
	)
	.clients(interactiveClient("main"), summarizerClient("summarizer"))
	.covers("op-stream", "op-ordering", "snapshot", "summarization")
	.steps((s) => {
		s.client("main").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("main").createDataStore("secondary");
		s.client("main").makeDataStoreVisible("secondary");

		s.client("main").submitOperation(op("reference-secondary", rootDataStore.id));
		s.client("main").submitOperation(op("seed-secondary", "secondary"));
		s.sequence().operations("seq-reference-secondary", "main", ["reference-secondary"]);
		s.sequence().operations("seq-seed-secondary", "main", ["seed-secondary"]);
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.service().synchronize();
		s.expectSummary("summary-1").toBe("acked", {
			dataStores: { root: "tree", secondary: "tree" },
		});

		s.client("summarizer").summarize({ id: "summary-2" });
		s.sequence().summarize("seq-summary-op-2", "summarizer", "summary-2");
		s.sequence().summaryAck("seq-summary-ack-2", "summary-2", "snapshot-2");
		s.service().synchronize();
		s.note(
			"No DataStore operation was sequenced between the two summaries, so both DataStores reuse handles.",
		);
		s.expectSummary("summary-2").toBe("acked", {
			dataStores: { root: "handle", secondary: "handle" },
		});

		s.client("main").submitOperation(op("change-root-only"));
		s.sequence().operations("seq-change-root-only", "main", ["change-root-only"]);
		s.service().synchronize();
		s.client("summarizer").summarize({ id: "summary-3" });
		s.sequence().summarize("seq-summary-op-3", "summarizer", "summary-3");
		s.sequence().summaryAck("seq-summary-ack-3", "summary-3", "snapshot-3");
		s.service().synchronize();
		s.expectOrder("seq-summary-ack-2", "seq-change-root-only");
		s.expectSummary("summary-3").toBe("acked", {
			dataStores: { root: "tree", secondary: "handle" },
		});
		s.expectTrace().toSatisfy();
	});

export const loadingGroupOfflineRefresh = fluidScenario(
	"loading-group state survives snapshot refresh and pending-state rehydrate",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/data-virtualization/groupIdOffline.spec.ts",
		suite: "GroupId offline",
		test: "GroupId offline with refresh",
		lines: "269-400",
	})
	.document(
		document(
			"collaboration",
			[
				rootDataStore,
				{ id: "group-a", loadingGroupId: "lazy-group", initiallyVisible: false },
				{ id: "group-b", loadingGroupId: "lazy-group", initiallyVisible: false },
			],
			{
				flushMode: "turnBased",
				enableGroupedBatching: true,
				useLoadingGroupIdForSnapshotFetch: true,
			},
		),
	)
	.clients(
		interactiveClient("main"),
		summarizerClient("summarizer"),
		interactiveClient("reader"),
		interactiveClient("resumed"),
	)
	.covers(
		"container-load",
		"data-virtualization",
		"driver-contracts",
		"op-ordering",
		"pending-state",
		"replay",
		"snapshot",
		"summarization",
	)
	.steps((s) => {
		s.client("main").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("main").createDataStore("group-a");
		s.client("main").createDataStore("group-b");
		s.client("main").makeDataStoreVisible("group-a");
		s.client("main").makeDataStoreVisible("group-b");

		s.note(
			"The source test stores both handles on the root DataStore in one turn, so this is one batch targeting one DataStore.",
		);
		s.client("main").submitBatch({
			id: "group-references",
			operations: [
				op("reference-group-a", rootDataStore.id),
				op("reference-group-b", rootDataStore.id),
			],
		});
		s.sequence().operations(
			"seq-group-references",
			"main",
			["reference-group-a", "reference-group-b"],
			{
				batch: "group-references",
				batchPosition: "single",
				virtualization: { grouped: true },
			},
		);
		s.note(
			"Grouping puts both operations at one sequence position; because they target one DataStore they also dispatch as one bunch. Grouping and bunching are different splits.",
		);
		s.expectBunches("seq-group-references").toBe([
			{
				dataStore: rootDataStore.id,
				operations: ["reference-group-a", "reference-group-b"],
			},
		]);
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.service().synchronize();

		s.client("reader").load({ from: { kind: "service", snapshot: "snapshot-1" } });
		s.expectDataStore("reader", "group-a").toBe("unloaded");
		s.expectDataStore("reader", "group-b").toBe("unloaded");
		s.client("reader").realizeDataStore("group-a");
		s.client("reader").realizeDataStore("group-b");
		s.expectSnapshotFetch("reader").toBe({
			purpose: "loadingGroup",
			loadingGroupId: "lazy-group",
			count: 1,
		});

		s.client("reader").submitOperation(op("group-a-online", "group-a"));
		s.client("reader").submitOperation(op("group-b-online", "group-b"));
		s.sequence().operations("seq-group-a-online", "reader", ["group-a-online"]);
		s.sequence().operations("seq-group-b-online", "reader", ["group-b-online"]);
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-2" });
		s.sequence().summarize("seq-summary-op-2", "summarizer", "summary-2");
		s.sequence().summaryAck("seq-summary-ack-2", "summary-2", "snapshot-2");
		s.service().synchronize();
		s.client("reader").requestLatestSnapshotRefresh("snapshot-2");
		s.note(
			"Refresh moves the reader's base snapshot forward to the second summary's reference position while its processing cursor stays ahead of it.",
		);

		s.client("reader").disconnect();
		s.client("reader").submitBatch({
			id: "loading-group-offline",
			operations: [op("group-a-offline", "group-a"), op("group-b-offline", "group-b")],
		});
		s.client("reader").capturePendingState("loading-group-pending-state");
		s.expectPendingState("loading-group-pending-state").toContain({
			captureKind: "pendingLocalState",
			savedOps: 2,
			stashedOps: 2,
			containsOperations: ["group-a-offline", "group-b-offline"],
		});
		s.client("reader").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "loading-group-pending-state",
				mode: "online",
			},
		});
		s.expectDelivery("resumed").toBe({
			loadedAt: { relation: "equal", position: "seq-group-b-online" },
			processedThrough: { relation: "after", position: "seq-group-b-online" },
		});
		s.client("resumed").disconnect();
		s.client("resumed").realizeDataStore("group-a");
		s.client("resumed").realizeDataStore("group-b");
		s.expectSnapshotFetch("resumed").toBe({
			purpose: "loadingGroup",
			loadingGroupId: "lazy-group",
			count: 0,
		});
		s.expectDataStore("resumed", "group-a").toBe("loaded", {
			containsOperations: ["group-a-online", "group-a-offline"],
		});
		s.expectDataStore("resumed", "group-b").toBe("loaded", {
			containsOperations: ["group-b-online", "group-b-offline"],
		});
		s.expectOperation("group-a-offline").at("resumed").toBe("pending");
		s.expectTrace().toSatisfy();
	});

export const containerRuntimeDslScenarios: readonly FluidScenario[] = [
	disconnectGatesInboundOps,
	pausedLoadAfterSummary,
	virtualizedOperationBatch,
	pendingBatchReentry,
	stashedOpsWithoutSavedOps,
	frozenOfflineRoundTrip,
	oldSummarizerFetchesLatestSnapshot,
	detachedSerializeAndRehydrate,
	incrementalDataStoreSummaries,
	loadingGroupOfflineRefresh,
];
