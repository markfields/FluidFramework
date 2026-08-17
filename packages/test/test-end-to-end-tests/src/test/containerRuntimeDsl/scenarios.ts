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

export const detachedSerializeRehydrateAndAttach = fluidScenario(
	"serialize and rehydrate a detached container, then attach it and collaborate",
)
	.fromTest({
		file: "packages/test/test-end-to-end-tests/src/test/deRehydrateContainerTests.spec.ts",
		suite: "Dehydrate Rehydrate Container Test",
		test: "Rehydrate container from snapshot and check contents before attach",
		lines: "441-517",
	})
	.document(document("collaboration", [rootDataStore]))
	.clients(interactiveClient("detached"), interactiveClient("rehydrated"))
	.covers("container-lifecycle", "container-load", "op-stream", "op-ordering", "snapshot")
	.steps((s) => {
		s.note(
			"The attach portion continues into the adjacent source test 'Rehydrate container from snapshot and check contents after attach' (lines 480-517). The final operation is the proof-of-concept bridge from Loader lifecycle into collaboration.",
		);
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

		s.client("rehydrated").beginAttach();
		s.note(
			"Attaching is a state of its own: storage exists, but the container is not yet a live collaborator.",
		);
		s.expectClient("rehydrated").toBe({
			attach: "attaching",
			connection: "disconnected",
			environment: "service",
		});
		s.service().completeAttach("rehydrated");
		s.expectClient("rehydrated").toBe({
			attach: "attached",
			connection: "connected",
			environment: "service",
		});

		s.client("rehydrated").submitOperation(op("first-attached-op"));
		s.note(
			"The first operation that can occupy a position in the total order is the first one submitted after the attach completes.",
		);
		s.expectOperation("first-attached-op").at("rehydrated").toBe("pending");
		s.sequence().operations("seq-first-attached-op", "rehydrated", ["first-attached-op"], {
			clientSequence: 1,
		});
		s.service().synchronize();
		s.expectOperation("first-attached-op").at("rehydrated").toBe("acked");
		s.expectDelivery("rehydrated").toBe({
			processedThrough: { relation: "equal", position: "seq-first-attached-op" },
		});
		s.expectTrace().toSatisfy();
	});

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
		s.expectClient("reader").toBe({ connection: "connected" });

		s.client("writer").submitOperation(op("initial-value"));
		s.sequence().operations("seq-initial", "writer", ["initial-value"]);
		s.service().synchronize();
		s.expectOperation("initial-value").at("reader").toBe("processed");

		s.client("reader").disconnect();
		s.expectClient("reader").toBe({ connection: "disconnected" });

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
			"Reconnecting restores the op stream but not the reader's position: it is still behind until the messages it missed are delivered.",
		);
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("sequenced");
		s.service().deliver("reader").through("seq-while-disconnected");
		s.expectOperation("value-while-reader-disconnected").at("reader").toBe("processed");
		s.expectDelivery("reader").toBe({
			processedThrough: { relation: "equal", position: "seq-while-disconnected" },
		});
		s.service().synchronize();
		s.expectConvergence("writer", "reader");
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

		const beforeSummary = [0, 1].map((index) => `before-summary-${index}`);
		s.client("writer").submitBatch({
			id: "before-summary",
			operations: beforeSummary.map((id) => op(id)),
		});
		for (const [index, id] of beforeSummary.entries()) {
			s.sequence().operations(`seq-${id}`, "writer", [id], {
				batch: "before-summary",
				batchPosition: index === 0 ? "start" : "end",
				clientSequence: index + 1,
			});
		}
		s.service().synchronize();

		s.client("summarizer").summarize({ id: "summary-1" });
		s.sequence().summarize("seq-summary-op-1", "summarizer", "summary-1");
		s.sequence().summaryAck("seq-summary-ack-1", "summary-1", "snapshot-1");
		s.service().synchronize();
		s.expectSummary("summary-1").toBe("acked");

		s.client("paused-reader").load({
			from: { kind: "service", snapshot: "snapshot-1" },
			pauseAt: "seq-before-summary-1",
		});
		s.note(
			"The snapshot content corresponds to the summary op's reference position, not to the position of the summary op or its ack.",
		);
		s.expectDelivery("paused-reader").toBe({
			loadedAt: { relation: "equal", position: "seq-before-summary-1" },
			processedThrough: { relation: "equal", position: "seq-before-summary-1" },
		});

		const afterSummary = [0, 1].map((index) => `after-summary-${index}`);
		s.client("writer").submitBatch({
			id: "after-summary",
			operations: afterSummary.map((id) => op(id)),
		});
		for (const [index, id] of afterSummary.entries()) {
			s.sequence().operations(`seq-${id}`, "writer", [id], {
				batch: "after-summary",
				batchPosition: index === 0 ? "start" : "end",
			});
		}
		s.service().synchronize("writer");
		s.note(
			"A paused load pins the processing cursor: later operations are ordered, but this container never advances through them.",
		);
		for (const id of afterSummary) {
			s.expectOperation(id).at("paused-reader").toBe("sequenced");
			s.expectOperation(id).at("paused-reader").toBeAppliedTimes(0);
		}
		s.expectDelivery("paused-reader").toBe({
			processedThrough: { relation: "equal", position: "seq-before-summary-1" },
		});
		s.expectOrder("seq-summary-ack-1", "seq-after-summary-0");
		s.expectTrace().toSatisfy();
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

		//* CPLT "reference-secondary" here doesn't indicate any actual reference added between those nodes. This seems lossy? Add to the backlog the idea of references between nodes (executor will implement by storing a handle to B in A's DDS)
		s.client("main").submitOperation(op("reference-secondary", rootDataStore.id));
		s.client("main").submitOperation(op("seed-secondary", "secondary"));
		//* CPLT can we pass the ops by reference instead of merely describing? e.g. there's no type safety on the strings passed for "operations" array
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
			savedOps: 0,
			stashedOps: 1,
			containsOperations: ["stashed-op"],
		});
		s.client("stashing-client").close();

		s.client("resumed").load({
			from: {
				kind: "pendingState",
				pendingState: "stash-without-saved-ops",
			},
		});
		s.expectOperation("stashed-op").at("resumed").toBe("pending");
		s.client("resumed").resubmitBatch({ batch: "stashed-batch" });
		s.note(
			"The replay carries a new client identity, but the logical operation keeps the identity it was given in the previous session.",
		);
		s.sequence().operations("seq-stashed", "resumed", ["stashed-op"], {
			batch: "stashed-batch",
			batchPosition: "single",
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

export const containerRuntimeDslScenarios: readonly FluidScenario[] = [
	detachedSerializeRehydrateAndAttach,
	disconnectGatesInboundOps,
	virtualizedOperationBatch,
	pausedLoadAfterSummary,
	incrementalDataStoreSummaries,
	stashedOpsWithoutSavedOps,
];
