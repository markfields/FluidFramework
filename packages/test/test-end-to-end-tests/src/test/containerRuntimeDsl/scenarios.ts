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
		lines: "374-462",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(interactiveClient("writer"), interactiveClient("reader"))
	.covers("container-lifecycle", "op-stream")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("reader").load({ from: { kind: "service" } });
		s.client("writer").submitOperation(op("initial-value"));
		s.service().synchronize();
		s.expectOperation("initial-value").at("reader").toBe("processed");

		s.client("reader").disconnect();
		s.expectClient("reader").toBe({ connection: "disconnected" });
		s.client("writer").submitOperation(op("value-while-reader-disconnected"));
		s.service().synchronize("writer");
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("notProcessed");

		s.client("reader").connect();
		s.service().synchronize();
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("processed");
	});

export const pausedLoadAfterSummary = fluidScenario(
	"load remains paused at the requested summary sequence",
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
	.covers("container-load", "snapshot", "summarization", "op-stream")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("writer").submitBatch({
			id: "before-summary",
			operations: [0, 1, 2, 3, 4].map((index) => op(`before-summary-${index}`)),
		});
		s.service().synchronize();
		s.client("summarizer").summarize({ id: "summary-1" });
		s.service().acknowledgeSummary("summary-1", "snapshot-1");

		s.client("paused-reader").load({
			from: { kind: "service", snapshot: "snapshot-1" },
			pauseAt: { kind: "summaryReferenceSequence", summary: "summary-1" },
		});
		s.expectSequence("paused-reader").toBe({
			last: { relation: "equal", summary: "summary-1" },
		});

		s.client("writer").submitBatch({
			id: "after-summary",
			operations: [0, 1, 2, 3, 4].map((index) => op(`after-summary-${index}`)),
		});
		s.service().synchronize("writer");
		for (let index = 0; index < 5; index++) {
			s.expectOperation(`after-summary-${index}`).at("paused-reader").toBe("notProcessed");
		}
		s.expectSequence("paused-reader").toBe({
			last: { relation: "equal", summary: "summary-1" },
		});
	});

export const virtualizedOperationBatch = fluidScenario(
	"group, compress, and chunk a DataStore operation batch",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/compression.spec.ts",
		suite: "Op Compression > Compression",
		test: "Correctly processes messages: compression [true] chunking [true] grouping [true]",
		lines: "137-178",
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
	.covers("op-stream", "op-virtualization")
	.steps((s) => {
		s.client("writer").load({ from: { kind: "service" } });
		s.client("reader").load({ from: { kind: "service" } });
		s.client("writer").submitBatch({
			id: "large-batch",
			operations: [
				op("large-op-0", rootDataStore.id, 100),
				op("large-op-1", rootDataStore.id, 100),
				op("large-op-2", rootDataStore.id, 100),
			],
		});
		s.expectBatch("large-batch").toBeVirtualizedAs({
			grouped: true,
			compressed: true,
			chunked: true,
			originalOperationCount: 3,
		});
		s.service().synchronize();
		for (let index = 0; index < 3; index++) {
			s.expectOperation(`large-op-${index}`).at("writer").toBe("acked");
			s.expectOperation(`large-op-${index}`).at("reader").toBe("processed");
		}
	});

export const pendingBatchReentry = fluidScenario(
	"reentrant pending batches are rebased and replayed in order",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/pendingBatchReentry.spec.ts",
		suite: "Op reentry and rebasing during pending batches",
		test: "Pending batches with reentry - SharedCounter",
		lines: "167-195",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "immediate",
			enableGroupedBatching: true,
			enableBatchIdTracking: true,
		}),
	)
	.clients(interactiveClient("writer"))
	.covers("op-stream", "pending-state")
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
		s.expectPendingReplay().toPreserve({
			batches: ["initial-batch", "reentrant-batch"],
			rebasedBatches: ["reentrant-batch"],
		});
		s.service().synchronize();
		s.expectOperation("initial-op").at("writer").toBe("acked");
		s.expectOperation("reentrant-op").at("writer").toBe("acked");
	});

export const stashedOpsWithoutSavedOps = fluidScenario(
	"rehydrate stashed operations based directly on a summary",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/offline/waitForSummary.spec.ts",
		suite: "Offline tests that wait for a summary",
		test: "applies stashed ops with no saved ops (map)",
		lines: "243-281",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "turnBased",
			enableGroupedBatching: true,
			enableBatchIdTracking: true,
		}),
	)
	.clients(
		interactiveClient("original"),
		summarizerClient("summarizer"),
		interactiveClient("stashing-client"),
		interactiveClient("resumed"),
	)
	.covers("container-load", "op-stream", "pending-state", "snapshot", "summarization")
	.steps((s) => {
		s.client("original").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("summarizer").summarize({ id: "summary-1" });
		s.service().acknowledgeSummary("summary-1", "snapshot-1");

		s.client("stashing-client").load({
			from: { kind: "service", snapshot: "snapshot-1" },
			deltaConnection: "none",
		});
		s.client("stashing-client").submitOperation(op("stashed-op"));
		s.client("stashing-client").capturePendingState("stash-without-saved-ops");
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
		s.service().synchronize();
		s.expectOperation("stashed-op").at("original").toBe("processed");
		s.expectOperation("stashed-op").at("resumed").toBe("acked");
	});

export const frozenOfflineRoundTrip = fluidScenario(
	"full capture supports writable frozen load and online resume",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/offline/frozenOfflineRoundTrip.spec.ts",
		suite: "Frozen offline pending-state round trip",
		test: "captureFullContainerState → offline writable load → re-capture → online resume",
		lines: "102-169",
	})
	.document(
		document("collaboration", [rootDataStore], {
			flushMode: "turnBased",
			enableGroupedBatching: true,
			enableBatchIdTracking: true,
			enableOfflineFull: true,
		}),
	)
	.clients(
		interactiveClient("original"),
		interactiveClient("offline"),
		interactiveClient("resumed"),
	)
	.covers("container-load", "op-stream", "pending-state", "snapshot")
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
		s.client("offline").submitBatch({
			id: "offline-edits",
			operations: [0, 1, 2, 3, 4].map((index) => op(`offline-${index}`)),
		});
		s.client("offline").capturePendingState("layered-pending-state");
		s.expectPendingState("layered-pending-state").toContain({
			captureKind: "pendingLocalState",
			stashedOps: 5,
			containsOperations: [0, 1, 2, 3, 4].map((index) => `offline-${index}`),
		});
		s.client("offline").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "layered-pending-state",
				mode: "online",
			},
		});
		s.service().synchronize();
		for (let index = 0; index < 5; index++) {
			s.expectOperation(`offline-${index}`).at("original").toBe("processed");
			s.expectOperation(`offline-${index}`).at("resumed").toBe("acked");
		}
	});

export const oldSummarizerFetchesLatestSnapshot = fluidScenario(
	"older summarizer refreshes to the latest acknowledged snapshot",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/summarization/summarizationFetchValidation.spec.ts",
		suite: "Summarizer fetches expected number of times",
		test: "Summarizer loading from an older summary should fetch latest summary",
		lines: "169-218",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(
		interactiveClient("main"),
		summarizerClient("summarizer-1"),
		summarizerClient("summarizer-2"),
	)
	.covers("driver-contracts", "snapshot", "summarization")
	.steps((s) => {
		s.client("main").load({ from: { kind: "service" } });
		s.client("summarizer-1").load({ from: { kind: "service" } });
		s.client("summarizer-2").load({ from: { kind: "service" } });
		s.client("main").submitOperation(op("before-summary"));
		s.service().synchronize();
		s.client("summarizer-1").summarize({ id: "summary-1" });
		s.service().acknowledgeSummary("summary-1", "snapshot-1");
		s.expectSummary("summary-1").toBe("acked", { stage: "submit" });

		s.client("main").submitOperation(op("ack-processing-trigger"));
		s.service().synchronize();
		s.expectSnapshotFetch("summarizer-2").toBe({
			purpose: "summaryAck",
			count: 1,
			snapshot: "snapshot-1",
		});
	});

export const detachedSerializeAndRehydrate = fluidScenario(
	"serialize and rehydrate a detached container before attach",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/deRehydrateContainerTests.spec.ts",
		suite: "Dehydrate Rehydrate Container Test",
		test: "Rehydrate container from snapshot and check contents before attach",
		lines: "441-479",
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
		s.expectClient("rehydrated").toBe({
			attach: "detached",
			connection: "disconnected",
			environment: "none",
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
	.covers("op-stream", "snapshot", "summarization")
	.steps((s) => {
		s.client("main").load({ from: { kind: "service" } });
		s.client("summarizer").load({ from: { kind: "service" } });
		s.client("main").createDataStore("secondary");
		s.client("main").makeDataStoreVisible("secondary");
		s.client("main").submitOperation(op("reference-secondary", rootDataStore.id));
		s.client("main").submitOperation(op("seed-secondary", "secondary"));
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-1" });
		s.service().acknowledgeSummary("summary-1", "snapshot-1");
		s.expectSummary("summary-1").toBe("acked", {
			dataStores: { root: "tree", secondary: "tree" },
		});

		s.client("summarizer").summarize({ id: "summary-2" });
		s.service().acknowledgeSummary("summary-2", "snapshot-2");
		s.expectSummary("summary-2").toBe("acked", {
			dataStores: { root: "handle", secondary: "handle" },
		});

		s.client("main").submitOperation(op("change-root-only"));
		s.service().synchronize();
		s.client("summarizer").summarize({ id: "summary-3" });
		s.service().acknowledgeSummary("summary-3", "snapshot-3");
		s.expectSummary("summary-3").toBe("acked", {
			dataStores: { root: "tree", secondary: "handle" },
		});
	});

export const loadingGroupOfflineRefresh = fluidScenario(
	"loading-group state survives snapshot refresh and pending-state rehydrate",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/data-virtualization/groupIdOffline.spec.ts",
		suite: "GroupId offline",
		test: "GroupId offline with refresh",
		lines: "269-410",
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
				enableBatchIdTracking: true,
				enableDataVirtualization: true,
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
		"pending-state",
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
		s.client("main").submitOperation(op("group-a-initial", "group-a"));
		s.client("main").submitOperation(op("group-b-initial", "group-b"));
		s.service().synchronize();
		s.client("summarizer").summarize({ id: "summary-1" });
		s.service().acknowledgeSummary("summary-1", "snapshot-1");

		s.client("reader").load({
			from: { kind: "service", snapshot: "snapshot-1" },
		});
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
		s.service().synchronize();
		s.client("summarizer").summarize({ id: "summary-2" });
		s.service().acknowledgeSummary("summary-2", "snapshot-2");
		s.client("reader").requestLatestSnapshotRefresh();
		s.client("reader").disconnect();
		s.client("reader").submitOperation(op("group-a-offline", "group-a"));
		s.client("reader").submitOperation(op("group-b-offline", "group-b"));
		s.client("reader").capturePendingState("loading-group-pending-state");
		s.client("reader").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "loading-group-pending-state",
				mode: "online",
			},
		});
		s.client("resumed").disconnect();
		s.expectSequence("resumed").toBe({
			initial: { relation: "equal", summary: "summary-2" },
			last: { relation: "after", summary: "summary-2" },
		});
		s.client("resumed").realizeDataStore("group-a");
		s.client("resumed").realizeDataStore("group-b");
		s.expectSnapshotFetch("resumed").toBe({
			purpose: "loadingGroup",
			loadingGroupId: "lazy-group",
			count: 0,
		});
		s.expectDataStore("resumed", "group-a").toBe("loaded", {
			containsOperations: ["group-a-initial", "group-a-online", "group-a-offline"],
		});
		s.expectDataStore("resumed", "group-b").toBe("loaded", {
			containsOperations: ["group-b-initial", "group-b-online", "group-b-offline"],
		});
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
