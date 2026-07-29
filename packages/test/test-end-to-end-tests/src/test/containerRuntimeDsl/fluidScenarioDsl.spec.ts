/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";

import {
	document,
	fluidScenario,
	interactiveClient,
	summarizerClient,
	type ScenarioSteps,
} from "./builder.js";
import {
	type ClientDefinition,
	type DocumentDefinition,
	type FluidScenario,
	type ScenarioSource,
	type TraceInvariant,
	allTraceInvariants,
} from "./model.js";
import { containerRuntimeDslScenarios } from "./scenarios.js";
import { assertValidScenario, validateScenario } from "./validator.js";

const root = { id: "root", root: true } as const;

const sources = {
	container: {
		file: "packages/test/test-end-to-end-tests/src/test/container.spec.ts",
		suite: "Container",
		test: "can control op processing with connect() and disconnect()",
	},
	concurrency: {
		file: "packages/test/test-end-to-end-tests/src/test/opReentrancy.spec.ts",
		suite: "Concurrent op processing via DDS event handlers",
		test: "Test reentrant op sending",
	},
	consensus: {
		file: "packages/test/test-end-to-end-tests/src/test/consensusRegisterCollectionEndToEndTests.spec.ts",
		suite: "ConsensusRegisterCollection",
		test: "Should store all concurrent writings on a key in sequenced order",
	},
	messageSize: {
		file: "packages/test/test-end-to-end-tests/src/test/messageSize.spec.ts",
		suite: "Message size > Resiliency > Local container",
		test: "Reconnects while sending chunks",
	},
	stashedOps: {
		file: "packages/test/test-end-to-end-tests/src/test/offline/stashedOps.spec.ts",
		suite: "stashed ops",
		test: "repeated getPendingLocalState across multiple connections doesn't duplicate ops",
	},
	loadModes: {
		file: "packages/test/test-end-to-end-tests/src/test/loadModes.spec.ts",
		suite: "LoadModes",
		test: "Can load a paused container at a specific sequence number",
	},
	summarize: {
		file: "packages/test/test-end-to-end-tests/src/test/summarization/summaries.spec.ts",
		suite: "Summaries",
		test: "On demand summaries",
	},
	fork: {
		file: "packages/test/test-end-to-end-tests/src/test/offline/stashedOps.spec.ts",
		suite: "Offline Phase 3",
		test: "Single-Threaded Fork: Closes (ForkedContainerError) when ops are submitted with different clientId from pendingLocalState (via Counter DDS)",
	},
	bunching: {
		file: "packages/test/test-end-to-end-tests/src/test/opBunching.spec.ts",
		suite: "Ops for DDSes are bunched together",
		test: "ops across two data store interleaved",
	},
} as const satisfies Record<string, ScenarioSource>;

const secondary = { id: "secondary" } as const;

const groupedDocument: DocumentDefinition = document("collaboration", [root], {
	flushMode: "turnBased",
	enableGroupedBatching: true,
});

const twoStoreGroupedDocument: DocumentDefinition = document(
	"collaboration",
	[root, secondary],
	{ flushMode: "turnBased", enableGroupedBatching: true },
);

function scenarioOf<const Names extends readonly [string, ...string[]]>(
	name: string,
	source: ScenarioSource,
	clientNames: Names,
	define: (steps: ScenarioSteps<Names[number]>) => void,
	documentDefinition: DocumentDefinition = document("collaboration", [root]),
): FluidScenario {
	const [first, ...rest] = clientNames;
	const definitions: [ClientDefinition, ...ClientDefinition[]] = [
		clientDefinitionFor(first),
		...rest.map(clientDefinitionFor),
	];
	return fluidScenario(name)
		.fromTest(source)
		.document(documentDefinition)
		.clients(...definitions)
		.covers("op-ordering")
		.steps(define as (steps: ScenarioSteps<string>) => void);
}

function clientDefinitionFor(id: string): ClientDefinition {
	return id.startsWith("summarizer") ? summarizerClient(id) : interactiveClient(id);
}

/**
 * One deliberately broken scenario per invariant, each ending in a checkpoint that names only
 * that invariant. Used to prove every accepted invariant name is backed by a real check.
 */
const invariantProbes: Readonly<
	Record<TraceInvariant, { fragment: string; build: () => FluidScenario }>
> = {
	denseTotalOrder: {
		fragment: "is declared more than once",
		build: () =>
			probe("denseTotalOrder", (s) => {
				s.client("alice").submitOperation({ id: "first", dataStore: "root" });
				s.client("alice").submitOperation({ id: "second", dataStore: "root" });
				s.sequence().operations("seq", "alice", ["first"]);
				s.sequence().operations("seq", "alice", ["second"]);
			}),
	},
	clientSequenceMonotonic: {
		fragment: "does not advance within",
		build: () =>
			probe("clientSequenceMonotonic", (s) => {
				s.client("alice").submitOperation({ id: "first", dataStore: "root" });
				s.client("alice").submitOperation({ id: "second", dataStore: "root" });
				s.sequence().operations("seq-first", "alice", ["first"], { clientSequence: 4 });
				s.sequence().operations("seq-second", "alice", ["second"], { clientSequence: 4 });
			}),
	},
	batchContiguity: {
		fragment: "should be marked",
		build: () =>
			probe("batchContiguity", (s) => {
				s.client("alice").submitBatch({
					id: "batch",
					operations: [
						{ id: "first", dataStore: "root" },
						{ id: "second", dataStore: "root" },
					],
				});
				s.sequence().operations("seq-first", "alice", ["first"], {
					batch: "batch",
					batchPosition: "start",
				});
				s.sequence().operations("seq-second", "alice", ["second"], {
					batch: "batch",
					batchPosition: "continuation",
				});
			}),
	},
	causalReferenceSequence: {
		fragment: "is ahead of what",
		build: () =>
			probe("causalReferenceSequence", (s) => {
				s.client("alice").submitOperation({ id: "first", dataStore: "root" });
				s.client("alice").submitOperation({ id: "second", dataStore: "root" });
				s.sequence().operations("seq-first", "alice", ["first"]);
				s.sequence().operations("seq-second", "alice", ["second"], {
					referenceSequence: "seq-first",
				});
			}),
	},
	minimumSequenceMonotonic: {
		fragment: "moved backwards",
		build: () =>
			probe("minimumSequenceMonotonic", (s) => {
				s.client("alice").submitOperation({ id: "first", dataStore: "root" });
				s.client("alice").submitOperation({ id: "second", dataStore: "root" });
				s.client("alice").submitOperation({ id: "third", dataStore: "root" });
				s.sequence().operations("seq-first", "alice", ["first"]);
				s.service().deliver("alice").through("seq-first");
				s.sequence().operations("seq-second", "alice", ["second"], {
					referenceSequence: "seq-first",
					minimumSequence: "seq-first",
				});
				s.sequence().operations("seq-third", "alice", ["third"], {
					minimumSequence: "baseline",
				});
			}),
	},
	wireReconstruction: {
		fragment: "was never reconstructed",
		build: () =>
			probe(
				"wireReconstruction",
				(s) => {
					s.client("alice").submitBatch({
						id: "large",
						operations: [{ id: "large-edit", dataStore: "root", sizeInBytes: 400 }],
					});
					s.sequence().chunk("seq-chunk-1", "alice", {
						batch: "large",
						index: 1,
						count: 2,
					});
				},
				document("collaboration", [root], {
					flushMode: "turnBased",
					enableGroupedBatching: true,
					compression: { algorithm: "lz4", minimumBatchSizeInBytes: 10 },
					chunkSizeInBytes: 100,
				}),
			),
	},
	exactlyOnceApplication: {
		fragment: "must be marked as a duplicate",
		build: () =>
			probe(
				"exactlyOnceApplication",
				(s) => {
					s.client("alice").submitBatch({
						id: "batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.sequence().operations("seq-first", "alice", ["edit"], {
						batch: "batch",
						batchPosition: "single",
						virtualization: { grouped: true },
					});
					s.client("alice").resubmitBatch({ batch: "batch", as: "batch-id" });
					s.sequence().operations("seq-second", "alice", ["edit"], {
						batch: "batch",
						batchPosition: "single",
						batchId: "batch-id",
						virtualization: { grouped: true },
					});
				},
				groupedDocument,
			),
	},
	orderedDelivery: {
		fragment: "cannot move its processing position backwards",
		build: () =>
			probe("orderedDelivery", (s) => {
				s.client("alice").submitOperation({ id: "first", dataStore: "root" });
				s.client("alice").submitOperation({ id: "second", dataStore: "root" });
				s.sequence().operations("seq-first", "alice", ["first"]);
				s.sequence().operations("seq-second", "alice", ["second"]);
				s.service().deliver("alice").through("seq-second");
				s.service().deliver("alice").through("seq-first");
			}),
	},
};

function probe(
	invariant: TraceInvariant,
	body: (steps: ScenarioSteps<"alice">) => void,
	documentDefinition: DocumentDefinition = document("collaboration", [root]),
): FluidScenario {
	return scenarioOf(
		`invariant probe: ${invariant}`,
		sources.loadModes,
		["alice"],
		(s) => {
			s.client("alice").load({ from: { kind: "service" } });
			body(s);
			s.expectTrace().toSatisfy([invariant]);
		},
		documentDefinition,
	);
}

function messagesOf(scenario: FluidScenario): readonly string[] {
	return validateScenario(scenario).map((issue) => issue.message);
}

function assertReports(scenario: FluidScenario, fragment: string): void {
	const messages = messagesOf(scenario);
	assert(
		messages.some((message) => message.includes(fragment)),
		`Expected a validation issue containing "${fragment}". Got:\n${messages.join("\n") || "(none)"}`,
	);
}

describe("Fluid Container Runtime collaboration DSL", () => {
	describe("acceptance set", () => {
		it("validates ten source-traceable e2e scenarios", () => {
			assert.strictEqual(containerRuntimeDslScenarios.length, 10);
			for (const scenario of containerRuntimeDslScenarios) {
				assert.doesNotThrow(() => assertValidScenario(scenario), scenario.name);
			}
		});

		it("covers every target subsystem", () => {
			const actualCoverage = new Set(
				containerRuntimeDslScenarios.flatMap((scenario) => scenario.coverage),
			);
			for (const required of [
				"container-lifecycle",
				"container-load",
				"driver-contracts",
				"op-stream",
				"op-ordering",
				"op-virtualization",
				"pending-state",
				"replay",
				"snapshot",
				"summarization",
				"data-virtualization",
			] as const) {
				assert(actualCoverage.has(required), `Missing coverage for ${required}`);
			}
		});

		it("produces a pure serializable semantic model", () => {
			for (const scenario of containerRuntimeDslScenarios) {
				const roundTripped: unknown = JSON.parse(JSON.stringify(scenario));
				assert.deepStrictEqual(roundTripped, scenario);
			}
		});

		it("keeps every acceptance scenario traceable to a real end-to-end test", () => {
			for (const scenario of containerRuntimeDslScenarios) {
				assert(scenario.source.file.endsWith(".spec.ts"), scenario.name);
				assert(scenario.source.lines !== undefined, scenario.name);
			}
		});
	});

	describe("explicit sequencing", () => {
		it("lets the trace, not the statement order, decide who won", () => {
			const scenario = scenarioOf(
				"concurrent submissions ordered by the service",
				sources.concurrency,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.concurrently((block) => {
						block.client("alice").submitOperation({ id: "alice-edit", dataStore: "root" });
						block.client("bob").submitOperation({ id: "bob-edit", dataStore: "root" });
					});
					s.sequence().operations("seq-bob", "bob", ["bob-edit"]);
					s.sequence().operations("seq-alice", "alice", ["alice-edit"]);
					s.expectOrder("seq-bob", "seq-alice");
					s.service().synchronize();
					s.expectConvergence("alice", "bob");
					s.expectTrace().toSatisfy();
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects an ordering claim the trace contradicts", () => {
			const scenario = scenarioOf(
				"contradictory ordering claim",
				sources.consensus,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.concurrently((block) => {
						block.client("alice").submitOperation({ id: "alice-edit", dataStore: "root" });
						block.client("bob").submitOperation({ id: "bob-edit", dataStore: "root" });
					});
					s.sequence().operations("seq-bob", "bob", ["bob-edit"]);
					s.sequence().operations("seq-alice", "alice", ["alice-edit"]);
					s.expectOrder("seq-alice", "seq-bob");
				},
			);

			assertReports(scenario, "does not precede 'seq-bob' in the declared total order");
		});

		it("allows a loop-generated concurrent block with one submission", () => {
			const scenario = scenarioOf(
				"degenerate concurrent block",
				sources.concurrency,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.concurrently((block) => {
						block.client("alice").submitOperation({ id: "alice-edit", dataStore: "root" });
					});
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a position name that collides with a reserved reference", () => {
			const scenario = scenarioOf(
				"reserved position name",
				sources.container,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("latest", "alice", ["edit"]);
				},
			);

			assertReports(scenario, "is a reserved sequence reference");
		});
	});

	describe("submission is not sequencing", () => {
		it("keeps a submitted operation pending until an entry carries it", () => {
			const scenario = scenarioOf(
				"submission precedes sequencing",
				sources.container,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.expectOperation("edit").at("alice").toBe("pending");
					s.expectOperation("edit").at("bob").toBe("notProcessed");
					s.sequence().operations("seq-edit", "alice", ["edit"]);
					s.expectOperation("edit").at("bob").toBe("sequenced");
					s.service().synchronize();
					s.expectOperation("edit").at("bob").toBe("processed");
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("does not confuse optimistic local application with processing or acknowledgement", () => {
			const scenario = scenarioOf(
				"local application is not delivery",
				sources.container,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.expectOperation("edit").at("alice").toBe("processed");
					s.sequence().operations("seq-edit", "alice", ["edit"]);
					s.expectOperation("edit").at("alice").toBe("acked");
				},
			);

			const messages = messagesOf(scenario);
			assert(
				messages.some((message) => message.includes("its state is 'pending'")),
				messages.join("\n"),
			);
			assert(
				messages.some((message) => message.includes("its state is 'sequenced'")),
				messages.join("\n"),
			);
		});

		it("rejects a peer that claims to have processed an unsequenced operation", () => {
			const scenario = scenarioOf(
				"processed without sequencing",
				sources.container,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.service().synchronize();
					s.expectOperation("edit").at("bob").toBe("processed");
				},
			);

			assertReports(scenario, "'bob' has not processed 'edit'");
		});

		it("rejects sequencing an operation the client never offered", () => {
			const scenario = scenarioOf(
				"sequencing an unsubmitted operation",
				sources.container,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "bob", ["edit"]);
				},
			);

			assertReports(scenario, "'bob' has no outstanding submission of operation 'edit'");
		});

		it("rejects sequencing from a disconnected client", () => {
			const scenario = scenarioOf(
				"sequencing while disconnected",
				sources.container,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.client("alice").disconnect();
					s.sequence().operations("seq-edit", "alice", ["edit"]);
				},
			);

			assertReports(scenario, "is disconnected, so nothing it submitted can be sequenced");
		});

		it("rejects sequencing from a read-mode connection", () => {
			const scenario = scenarioOf(
				"sequencing while read-only at the transport layer",
				sources.container,
				["alice"],
				(s) => {
					s.client("alice").load({
						from: { kind: "service" },
						requestedConnectionMode: "read",
					});
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "alice", ["edit"]);
				},
			);

			assertReports(scenario, "is connected in read mode");
		});

		it("rejects sequencing from a client whose outbound queue is paused", () => {
			const scenario = scenarioOf(
				"sequencing behind a paused outbound queue",
				sources.loadModes,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.processing("alice").pause("outbound");
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "alice", ["edit"]);
				},
			);

			assertReports(scenario, "has a paused outbound queue");
		});
	});

	describe("per-client processing lag", () => {
		it("lets two clients sit at different positions in one total order", () => {
			const scenario = scenarioOf(
				"processing lag between peers",
				sources.loadModes,
				["fast", "slow"],
				(s) => {
					s.client("fast").load({ from: { kind: "service" } });
					s.client("slow").load({ from: { kind: "service" } });
					s.client("fast").submitOperation({ id: "first", dataStore: "root" });
					s.client("fast").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-first", "fast", ["first"]);
					s.sequence().operations("seq-second", "fast", ["second"]);
					s.service().deliver("slow").through("seq-first");
					s.service().deliver("fast").through("latest");
					s.expectDelivery("slow").toBe({
						processedThrough: { relation: "equal", position: "seq-first" },
					});
					s.expectDelivery("fast").toBe({
						processedThrough: { relation: "after", position: "seq-first" },
					});
					s.expectOperation("second").at("slow").toBe("sequenced");
					s.expectOperation("second").at("fast").toBe("acked");
					s.service().synchronize();
					s.expectConvergence("fast", "slow");
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a cursor that moves backwards", () => {
			const scenario = scenarioOf(
				"rewinding a processing cursor",
				sources.loadModes,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-first", "alice", ["first"]);
					s.sequence().operations("seq-second", "alice", ["second"]);
					s.service().deliver("alice").through("seq-second");
					s.service().deliver("alice").through("seq-first");
				},
			);

			assertReports(scenario, "cannot move its processing position backwards");
		});

		it("rejects delivery to a client with a paused inbound queue", () => {
			const scenario = scenarioOf(
				"delivery behind a paused inbound queue",
				sources.loadModes,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.processing("bob").pause("inbound");
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "alice", ["edit"]);
					s.service().deliver("bob").through("latest");
				},
			);

			assertReports(scenario, "has a paused inbound queue");
		});

		it("rejects a delivery expectation the cursor does not support", () => {
			const scenario = scenarioOf(
				"overstated processing position",
				sources.loadModes,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "alice", ["edit"]);
					s.expectDelivery("bob").toBe({
						processedThrough: { relation: "equal", position: "seq-edit" },
					});
				},
			);

			assertReports(scenario, "Expected processed through equal 'seq-edit'");
		});
	});

	describe("replay queues", () => {
		it("derives the replay order from the client's outstanding submissions", () => {
			const scenario = scenarioOf("replay queue order", sources.stashedOps, ["alice"], (s) => {
				s.client("alice").load({ from: { kind: "service" } });
				s.client("alice").submitBatch({
					id: "first-batch",
					operations: [{ id: "first", dataStore: "root" }],
				});
				s.client("alice").submitBatch({
					id: "second-batch",
					operations: [{ id: "second", dataStore: "root" }],
				});
				s.expectPendingReplay("alice").toPreserve({
					batches: ["second-batch", "first-batch"],
				});
			});

			assertReports(scenario, "will replay [first-batch, second-batch]");
		});

		it("does not silently omit loose operations from a batch replay expectation", () => {
			const scenario = scenarioOf(
				"loose operation in replay queue",
				sources.stashedOps,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "loose", dataStore: "root" });
					s.expectPendingReplay("alice").toPreserve({ batches: [] });
				},
			);

			assertReports(scenario, "has unbatched pending operations [loose]");
		});
	});

	describe("replay and exactly-once application", () => {
		it("applies a replayed batch once when the replay preserves the batch identity", () => {
			const scenario = scenarioOf(
				"repeated replay does not duplicate an operation",
				sources.stashedOps,
				["origin", "peer", "resumed"],
				(s) => {
					s.client("origin").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("origin").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.client("origin").capturePendingState("stash");
					s.client("origin").close();

					s.client("resumed").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });
					s.sequence().operations("seq-first-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
						clientSequence: 1,
						virtualization: { grouped: true },
					});

					s.note(
						"The client reconnects before processing its own acknowledgement, so it replays the same logical batch a second time.",
					);
					s.client("resumed").disconnect();
					s.client("resumed").connect();
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });
					s.sequence().operations("seq-second-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
						clientSequence: 1,
						duplicateOf: "seq-first-replay",
						virtualization: { grouped: true },
					});

					s.service().synchronize();
					s.expectOperation("edit").at("peer").toBeAppliedTimes(1);
					s.expectOperation("edit").at("resumed").toBeAppliedTimes(1);
					s.expectBatch("edit-batch").toBeVirtualizedAs({
						grouped: true,
						compressed: false,
						chunked: false,
						originalOperationCount: 1,
						wireMessages: 1,
					});
					s.expectConvergence("peer", "resumed");
					s.expectTrace().toSatisfy(["exactlyOnceApplication"]);
				},
				groupedDocument,
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a repeat that is not declared a duplicate", () => {
			const scenario = scenarioOf(
				"undeclared duplicate batch",
				sources.stashedOps,
				["origin", "peer", "resumed"],
				(s) => {
					s.client("origin").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("origin").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.client("origin").capturePendingState("stash");
					s.client("origin").close();
					s.client("resumed").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });
					s.sequence().operations("seq-first-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
						virtualization: { grouped: true },
					});
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });
					s.sequence().operations("seq-second-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
						virtualization: { grouped: true },
					});
					s.service().synchronize();
				},
				groupedDocument,
			);

			const messages = messagesOf(scenario);
			assert(
				messages.some((message) =>
					message.includes("must be marked as a duplicate of the earlier entry"),
				),
				messages.join("\n"),
			);
			assert(
				messages.some((message) => message.includes("was already sequenced")),
				messages.join("\n"),
			);
		});

		it("rejects a replay that loses the original batch identity", () => {
			const scenario = scenarioOf(
				"replay under a fresh batch identity",
				sources.stashedOps,
				["origin", "peer", "resumed"],
				(s) => {
					s.client("origin").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("origin").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.client("origin").capturePendingState("stash");
					s.client("origin").close();
					s.client("resumed").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "original-id" });
					s.sequence().operations("seq-first-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "original-id",
						virtualization: { grouped: true },
					});
					s.client("resumed").resubmitBatch({ batch: "edit-batch", as: "fresh-id" });
					s.sequence().operations("seq-second-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "fresh-id",
						duplicateOf: "seq-first-replay",
						virtualization: { grouped: true },
					});
				},
				groupedDocument,
			);

			assertReports(scenario, "must preserve the original batch id");
		});

		it("closes a forked container instead of applying the same work twice", () => {
			const scenario = scenarioOf(
				"single-threaded fork under a different client identity",
				sources.fork,
				["origin", "peer", "winner", "forked"],
				(s) => {
					s.client("origin").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("origin").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.client("origin").capturePendingState("stash");
					s.client("origin").close();

					s.note("The same captured state is rehydrated twice, so two sessions hold it.");
					s.client("winner").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.client("forked").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.client("winner").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });
					s.client("forked").resubmitBatch({ batch: "edit-batch", as: "edit-batch-id" });

					s.sequence().operations("seq-winner", "winner", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
						clientSequence: 1,
						virtualization: { grouped: true },
					});
					s.note(
						"The forked session sees its own outstanding batch identity arrive under another client identity, so it closes before applying it.",
					);
					s.service().synchronize();

					s.expectClient("forked").toBe({ closed: true, outcome: "forkedContainer" });
					s.expectClient("winner").toBe({ closed: false });
					s.expectOperation("edit").at("forked").toBeAppliedTimes(1);
					s.expectOperation("edit").at("winner").toBeAppliedTimes(1);
					s.expectOperation("edit").at("peer").toBeAppliedTimes(1);
					s.expectTrace().toSatisfy(["exactlyOnceApplication"]);
				},
				groupedDocument,
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects an explicit batch identity without batch-id tracking", () => {
			const scenario = scenarioOf(
				"batch identity without tracking",
				sources.stashedOps,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.sequence().operations("seq-edit", "alice", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						batchId: "edit-batch-id",
					});
				},
				document("collaboration", [root], {
					disableBatchIdTracking: true,
				}),
			);

			assertReports(scenario, "explicit batch identity requires batch-id tracking");
		});

		it("rejects a rehydrated replay that omits the original batch identity", () => {
			const scenario = scenarioOf(
				"rehydrated replay without a batch identity",
				sources.stashedOps,
				["origin", "peer", "resumed"],
				(s) => {
					s.client("origin").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("origin").submitBatch({
						id: "edit-batch",
						operations: [{ id: "edit", dataStore: "root" }],
					});
					s.client("origin").capturePendingState("stash");
					s.client("origin").close();
					s.client("resumed").load({
						from: { kind: "pendingState", pendingState: "stash", mode: "online" },
					});
					s.note(
						"The replay carries a fresh client identity, so a derived batch id would not match the original.",
					);
					s.sequence().operations("seq-replay", "resumed", ["edit"], {
						batch: "edit-batch",
						batchPosition: "single",
						clientSequence: 1,
						virtualization: { grouped: true },
					});
					s.service().synchronize();
				},
				groupedDocument,
			);

			assertReports(scenario, "must carry the original batch id");
		});
	});

	describe("wire virtualization", () => {
		it("distinguishes a logical batch from the wire messages that carry it", () => {
			const scenario = scenarioOf(
				"grouped batch spans one sequenced message",
				sources.summarize,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "grouped-batch",
						operations: [
							{ id: "edit-0", dataStore: "root" },
							{ id: "edit-1", dataStore: "root" },
							{ id: "edit-2", dataStore: "root" },
						],
					});
					s.sequence().operations("seq-grouped", "alice", ["edit-0", "edit-1", "edit-2"], {
						batch: "grouped-batch",
						batchPosition: "single",
						virtualization: { grouped: true },
					});
					s.expectBatch("grouped-batch").toBeVirtualizedAs({
						grouped: true,
						compressed: false,
						chunked: false,
						originalOperationCount: 3,
						wireMessages: 1,
					});
					s.service().synchronize();
					s.expectConvergence("alice", "bob");
				},
				groupedDocument,
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects another sequenced message interleaved inside one batch transmission", () => {
			const scenario = scenarioOf(
				"interleaved batch transmission",
				sources.summarize,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "alice-batch",
						operations: [
							{ id: "alice-0", dataStore: "root" },
							{ id: "alice-1", dataStore: "root" },
						],
					});
					s.client("bob").submitOperation({ id: "bob-0", dataStore: "root" });
					s.sequence().operations("seq-alice-0", "alice", ["alice-0"], {
						batch: "alice-batch",
					});
					s.sequence().operations("seq-bob-0", "bob", ["bob-0"]);
					s.sequence().operations("seq-alice-1", "alice", ["alice-1"], {
						batch: "alice-batch",
					});
				},
			);

			assertReports(scenario, "is interleaved with another sequenced message");
		});

		it("accepts a chunk run abandoned by a reconnect and replayed afterwards", () => {
			const scenario = scenarioOf(
				"reconnect while sending chunks",
				sources.messageSize,
				["sender", "peer"],
				(s) => {
					s.client("sender").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("sender").submitBatch({
						id: "large-batch",
						operations: [{ id: "large-edit", dataStore: "root", sizeInBytes: 400 }],
					});
					s.sequence().chunk("seq-chunk-1", "sender", {
						batch: "large-batch",
						index: 1,
						count: 3,
					});
					s.sequence().chunk("seq-chunk-2", "sender", {
						batch: "large-batch",
						index: 2,
						count: 3,
					});
					s.note(
						"The sender loses its connection between chunks, so the partial payload is never reconstructed and the whole batch must be replayed.",
					);
					s.client("sender").disconnect();
					s.expectOperation("large-edit").at("peer").toBe("notProcessed");
					s.client("sender").connect();
					s.client("sender").resubmitBatch({ batch: "large-batch", as: "large-batch-id" });
					s.sequence().chunk("seq-replay-chunk-1", "sender", {
						batch: "large-batch",
						index: 1,
						count: 2,
					});
					s.sequence().operations("seq-replay-chunk-2", "sender", ["large-edit"], {
						batch: "large-batch",
						batchId: "large-batch-id",
						virtualization: {
							grouped: true,
							compressed: true,
							chunk: { index: 2, count: 2 },
						},
					});
					s.service().synchronize();
					s.expectOperation("large-edit").at("peer").toBeAppliedTimes(1);
					s.expectOperation("large-edit").at("sender").toBeAppliedTimes(1);
					s.expectTrace().toSatisfy(["wireReconstruction", "exactlyOnceApplication"]);
				},
				document("collaboration", [root], {
					flushMode: "turnBased",
					enableGroupedBatching: true,
					compression: { algorithm: "lz4", minimumBatchSizeInBytes: 10 },
					chunkSizeInBytes: 100,
				}),
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a chunk run that is never completed or abandoned", () => {
			const scenario = scenarioOf(
				"incomplete chunk run",
				sources.messageSize,
				["sender", "peer"],
				(s) => {
					s.client("sender").load({ from: { kind: "service" } });
					s.client("peer").load({ from: { kind: "service" } });
					s.client("sender").submitBatch({
						id: "large-batch",
						operations: [{ id: "large-edit", dataStore: "root", sizeInBytes: 400 }],
					});
					s.sequence().chunk("seq-chunk-1", "sender", {
						batch: "large-batch",
						index: 1,
						count: 3,
					});
					s.sequence().chunk("seq-chunk-2", "sender", {
						batch: "large-batch",
						index: 2,
						count: 3,
					});
					s.service().synchronize();
				},
				document("collaboration", [root], {
					flushMode: "turnBased",
					enableGroupedBatching: true,
					compression: { algorithm: "lz4", minimumBatchSizeInBytes: 10 },
					chunkSizeInBytes: 100,
				}),
			);

			assertReports(scenario, "delivered 2 of 3 chunks and was never reconstructed");
		});

		it("rejects an intermediate chunk that claims to reconstruct a payload", () => {
			const scenario = scenarioOf(
				"intermediate chunk carrying operations",
				sources.messageSize,
				["sender"],
				(s) => {
					s.client("sender").load({ from: { kind: "service" } });
					s.client("sender").submitBatch({
						id: "large-batch",
						operations: [{ id: "large-edit", dataStore: "root", sizeInBytes: 400 }],
					});
					s.sequence().operations("seq-chunk-1", "sender", ["large-edit"], {
						batch: "large-batch",
						virtualization: { chunk: { index: 1, count: 2 } },
					});
				},
				document("collaboration", [root], {
					flushMode: "turnBased",
					enableGroupedBatching: true,
					compression: { algorithm: "lz4", minimumBatchSizeInBytes: 10 },
					chunkSizeInBytes: 100,
				}),
			);

			assertReports(scenario, "only the final chunk carries operations");
		});

		it("rejects a grouped batch that claims more than one sequenced message", () => {
			const scenario = scenarioOf(
				"grouped batch spread across messages",
				sources.summarize,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "grouped-batch",
						operations: [
							{ id: "edit-0", dataStore: "root" },
							{ id: "edit-1", dataStore: "root" },
						],
					});
					s.sequence().operations("seq-a", "alice", ["edit-0"], {
						batch: "grouped-batch",
						batchPosition: "start",
						virtualization: { grouped: true },
					});
					s.sequence().operations("seq-b", "alice", ["edit-1"], {
						batch: "grouped-batch",
						batchPosition: "end",
						virtualization: { grouped: true },
					});
					s.expectBatch("grouped-batch").toBeVirtualizedAs({
						grouped: true,
						compressed: false,
						chunked: false,
						wireMessages: 2,
					});
				},
				groupedDocument,
			);

			assertReports(scenario, "must occupy exactly one sequenced message");
		});
	});

	describe("ordering metadata", () => {
		it("rejects a reference sequence number the submitter had not reached", () => {
			const scenario = scenarioOf(
				"reference sequence from the future",
				sources.loadModes,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("bob").submitOperation({ id: "bob-edit", dataStore: "root" });
					s.sequence().operations("seq-bob", "bob", ["bob-edit"]);
					s.client("alice").submitOperation({ id: "alice-edit", dataStore: "root" });
					s.note("Alice never processed Bob's operation, so she cannot reference it.");
					s.sequence().operations("seq-alice", "alice", ["alice-edit"], {
						referenceSequence: "seq-bob",
					});
				},
			);

			assertReports(scenario, "is ahead of what 'alice' had processed");
		});

		it("rejects a client sequence number that does not advance within a connection", () => {
			const scenario = scenarioOf(
				"stalled client sequence numbers",
				sources.loadModes,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-first", "alice", ["first"], { clientSequence: 4 });
					s.sequence().operations("seq-second", "alice", ["second"], { clientSequence: 4 });
				},
			);

			assertReports(scenario, "does not advance within 'alice' current connection");
		});

		it("rejects a minimum sequence number that moves backwards", () => {
			const scenario = scenarioOf(
				"regressing minimum sequence number",
				sources.loadModes,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "alice", ["first"]);
					s.service().synchronize();
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-second", "alice", ["second"], {
						minimumSequence: "seq-first",
					});
					s.client("alice").submitOperation({ id: "third", dataStore: "root" });
					s.sequence().operations("seq-third", "alice", ["third"], {
						minimumSequence: "baseline",
					});
				},
			);

			assertReports(scenario, "Minimum sequence number moved backwards");
		});

		it("rejects a minimum sequence number past a live submitter's reference position", () => {
			const scenario = scenarioOf(
				"minimum sequence number past the reference position",
				sources.loadModes,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "alice", ["first"]);
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.note(
						"Alice never processed her own first operation, so her reference stays at the baseline.",
					);
					s.sequence().operations("seq-second", "alice", ["second"], {
						minimumSequence: "seq-first",
					});
				},
			);

			assertReports(scenario, "passes the reference sequence number of a live submitter");
		});

		it("rejects a duplicated sequence position name", () => {
			const scenario = scenarioOf(
				"duplicated sequence position",
				sources.loadModes,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq", "alice", ["first"]);
					s.sequence().operations("seq", "alice", ["second"]);
				},
			);

			assertReports(scenario, "is declared more than once");
		});
	});

	describe("summaries in the op stream", () => {
		it("treats the summary op and its acknowledgement as sequenced messages", () => {
			const scenario = scenarioOf(
				"summary ack is a trace entry",
				sources.summarize,
				["main", "summarizer"],
				(s) => {
					s.client("main").load({ from: { kind: "service" } });
					s.client("summarizer").load({ from: { kind: "service" } });
					s.client("main").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "main", ["edit"]);
					s.service().synchronize();
					s.client("summarizer").summarize({ id: "summary-1" });
					s.expectSummary("summary-1").toBe("local");
					s.sequence().summarize("seq-summary-op", "summarizer", "summary-1");
					s.expectSummary("summary-1").toBe("broadcast");
					s.sequence().summaryAck("seq-summary-ack", "summary-1", "snapshot-1");
					s.expectSummary("summary-1").toBe("acked");
					s.expectOrder("seq-edit", "seq-summary-op");
					s.expectOrder("seq-summary-op", "seq-summary-ack");
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("allows a service acknowledgement after the collaboration window advances", () => {
			const scenario = scenarioOf(
				"summary ack after minimum sequence advances",
				sources.summarize,
				["main", "summarizer"],
				(s) => {
					s.client("main").load({ from: { kind: "service" } });
					s.client("summarizer").load({ from: { kind: "service" } });
					s.client("main").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "main", ["first"]);
					s.service().synchronize();
					s.sequence().noop("seq-main-noop", "main");
					s.sequence().noop("seq-summarizer-noop", "summarizer");
					s.client("main").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-second", "main", ["second"], {
						referenceSequence: "seq-first",
						minimumSequence: "seq-first",
					});
					s.client("summarizer").summarize({ id: "summary-1" });
					s.sequence().summarize("seq-summary-op", "summarizer", "summary-1");
					s.sequence().summaryAck("seq-summary-ack", "summary-1", "snapshot-1");
					s.expectTrace().toSatisfy(["minimumSequenceMonotonic"]);
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects an acknowledgement for a summary op that was never sequenced", () => {
			const scenario = scenarioOf(
				"acknowledging an unbroadcast summary",
				sources.summarize,
				["main", "summarizer"],
				(s) => {
					s.client("main").load({ from: { kind: "service" } });
					s.client("summarizer").load({ from: { kind: "service" } });
					s.client("summarizer").summarize({ id: "summary-1" });
					s.sequence().summaryAck("seq-summary-ack", "summary-1", "snapshot-1");
				},
			);

			assertReports(scenario, "has no sequenced summary op to acknowledge");
		});

		it("rejects a snapshot refresh that names a snapshot which does not exist", () => {
			const scenario = scenarioOf(
				"refresh mints no snapshot",
				sources.summarize,
				["main"],
				(s) => {
					s.client("main").load({ from: { kind: "service" } });
					s.client("main").requestLatestSnapshotRefresh("snapshot-from-nowhere");
				},
			);

			assertReports(scenario, "does not produce one");
		});
	});

	describe("membership and catch-up", () => {
		it("treats a join as the point a client becomes live and caught up", () => {
			const scenario = scenarioOf(
				"join marks the catch-up point",
				sources.container,
				["writer", "joiner"],
				(s) => {
					s.client("writer").load({ from: { kind: "service" } });
					s.client("joiner").load({ from: { kind: "service" } });
					s.expectClient("joiner").toBe({ connection: "catchingUp" });
					s.client("writer").submitOperation({ id: "before-join", dataStore: "root" });
					s.sequence().operations("seq-before-join", "writer", ["before-join"]);
					s.note("The joiner processes everything ordered before its join position.");
					s.sequence().join("seq-join", "joiner");
					s.expectClient("joiner").toBe({ connection: "connected" });
					s.expectOperation("before-join").at("joiner").toBe("processed");
					s.expectDelivery("joiner").toBe({
						processedThrough: { relation: "equal", position: "seq-join" },
					});
					s.expectTrace().toSatisfy();
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects sequencing from a client that has not finished catching up", () => {
			const scenario = scenarioOf(
				"sequencing before the join",
				sources.container,
				["joiner"],
				(s) => {
					s.client("joiner").load({ from: { kind: "service" } });
					s.client("joiner").submitOperation({ id: "eager", dataStore: "root" });
					s.sequence().operations("seq-eager", "joiner", ["eager"]);
					s.sequence().join("seq-join", "joiner");
				},
			);

			assertReports(scenario, "'joiner' is disconnected, so nothing it submitted");
		});

		it("keeps a client catching up while its inbound queue is paused", () => {
			const scenario = scenarioOf(
				"join behind a paused inbound queue",
				sources.loadModes,
				["writer", "joiner"],
				(s) => {
					s.client("writer").load({ from: { kind: "service" } });
					s.client("joiner").load({ from: { kind: "service" } });
					s.processing("joiner").pause("inbound");
					s.client("writer").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "writer", ["edit"]);
					s.sequence().join("seq-join", "joiner");
					s.note("The join is ordered, but a paused container has not processed it.");
					s.expectClient("joiner").toBe({ connection: "catchingUp" });
					s.expectOperation("edit").at("joiner").toBe("sequenced");
					s.processing("joiner").resume("inbound");
					s.service().deliver("joiner").through("seq-join");
					s.expectClient("joiner").toBe({ connection: "connected" });
					s.expectOperation("edit").at("joiner").toBe("processed");
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("does not let join catch-up move a paused load past its pinned position", () => {
			const scenario = scenarioOf(
				"join respects a paused load position",
				sources.loadModes,
				["writer", "joiner"],
				(s) => {
					s.client("writer").load({ from: { kind: "service" } });
					s.client("writer").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "writer", ["first"]);
					s.client("writer").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-second", "writer", ["second"]);
					s.client("joiner").load({
						from: { kind: "service" },
						pauseAt: "seq-first",
					});
					s.sequence().join("seq-join", "joiner");
					s.expectClient("joiner").toBe({ connection: "catchingUp" });
					s.expectOperation("first").at("joiner").toBe("processed");
					s.expectOperation("second").at("joiner").toBe("sequenced");
					s.expectDelivery("joiner").toBe({
						processedThrough: { relation: "equal", position: "seq-first" },
					});
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a leave from a client that still holds its connection", () => {
			const scenario = scenarioOf("premature leave", sources.container, ["joiner"], (s) => {
				s.client("joiner").load({ from: { kind: "service" } });
				s.sequence().join("seq-join", "joiner");
				s.sequence().leave("seq-leave", "joiner");
			});

			assertReports(scenario, "still holds its connection");
		});

		it("rejects a collaboration window that passes a live client's reference position", () => {
			const scenario = scenarioOf(
				"window past a live client",
				sources.loadModes,
				["writer", "lagging"],
				(s) => {
					s.client("writer").load({ from: { kind: "service" } });
					s.client("lagging").load({ from: { kind: "service" } });
					s.client("writer").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "writer", ["first"]);
					s.service().deliver("writer").through("seq-first");
					s.client("writer").submitOperation({ id: "second", dataStore: "root" });
					s.note(
						"The lagging client never advanced, so the window cannot move past the baseline.",
					);
					s.sequence().operations("seq-second", "writer", ["second"], {
						referenceSequence: "seq-first",
						minimumSequence: "seq-first",
					});
				},
			);

			assertReports(scenario, "passes the least reference position among live clients");
		});

		it("derives client state instead of trusting the declaration", () => {
			const scenario = scenarioOf(
				"contradicted client state",
				sources.container,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "edit", dataStore: "root" });
					s.expectClient("alice").toBe({ connection: "disconnected", dirty: "saved" });
				},
			);

			const messages = messagesOf(scenario);
			assert(
				messages.some((message) => message.includes("has connection 'connected'")),
				messages.join("\n"),
			);
			assert(
				messages.some((message) => message.includes("has dirty 'dirty'")),
				messages.join("\n"),
			);
		});

		it("rejects an outcome that the timeline never produced", () => {
			const scenario = scenarioOf(
				"healthy client cannot claim a fork outcome",
				sources.fork,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.expectClient("alice").toBe({ outcome: "forkedContainer" });
				},
			);

			assertReports(scenario, "has outcome 'undefined'");
		});
	});

	describe("the collaboration window", () => {
		it("lets a lagging client release the window with a noop", () => {
			const scenario = scenarioOf(
				"noop advances a lagging client's reference position",
				sources.loadModes,
				["writer", "lagging"],
				(s) => {
					s.client("writer").load({ from: { kind: "service" } });
					s.client("lagging").load({ from: { kind: "service" } });
					s.client("writer").submitOperation({ id: "first", dataStore: "root" });
					s.sequence().operations("seq-first", "writer", ["first"]);
					s.service().synchronize();
					s.note(
						"Both clients have processed the first operation, but the window still sits at the baseline until each of them says so.",
					);
					s.sequence().noop("seq-lagging-noop", "lagging");
					s.client("writer").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-second", "writer", ["second"], {
						referenceSequence: "seq-first",
						minimumSequence: "seq-first",
					});
					s.service().synchronize();
					s.expectConvergence("writer", "lagging");
					s.expectTrace().toSatisfy();
				},
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});
	});

	describe("dispatch bunches", () => {
		it("splits one sequenced message wherever the target DataStore changes", () => {
			const scenario = scenarioOf(
				"bunches inside a grouped batch",
				sources.bunching,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "interleaved",
						operations: [
							{ id: "root-0", dataStore: "root" },
							{ id: "root-1", dataStore: "root" },
							{ id: "second-0", dataStore: "secondary" },
							{ id: "root-2", dataStore: "root" },
						],
					});
					s.sequence().operations(
						"seq-interleaved",
						"alice",
						["root-0", "root-1", "second-0", "root-2"],
						{
							batch: "interleaved",
							batchPosition: "single",
							virtualization: { grouped: true },
						},
					);
					s.note(
						"Returning to a DataStore after leaving it starts a new bunch; bunches are contiguous runs, not per-DataStore totals.",
					);
					s.expectBunches("seq-interleaved").toBe([
						{ dataStore: "root", operations: ["root-0", "root-1"] },
						{ dataStore: "secondary", operations: ["second-0"] },
						{ dataStore: "root", operations: ["root-2"] },
					]);
					s.service().synchronize();
					s.expectConvergence("alice", "bob");
				},
				twoStoreGroupedDocument,
			);

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects a bunch claim that merges non-adjacent operations", () => {
			const scenario = scenarioOf(
				"merged bunch claim",
				sources.bunching,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "interleaved",
						operations: [
							{ id: "root-0", dataStore: "root" },
							{ id: "second-0", dataStore: "secondary" },
							{ id: "root-1", dataStore: "root" },
						],
					});
					s.sequence().operations(
						"seq-interleaved",
						"alice",
						["root-0", "second-0", "root-1"],
						{
							batch: "interleaved",
							batchPosition: "single",
							virtualization: { grouped: true },
						},
					);
					s.expectBunches("seq-interleaved").toBe([
						{ dataStore: "root", operations: ["root-0", "root-1"] },
						{ dataStore: "secondary", operations: ["second-0"] },
					]);
				},
				twoStoreGroupedDocument,
			);

			assertReports(scenario, "dispatches as [rootx1, secondaryx1, rootx1]");
		});

		it("rejects an ungrouped wire message carrying more than one operation", () => {
			const scenario = scenarioOf(
				"ungrouped multi-operation message",
				sources.bunching,
				["alice"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitBatch({
						id: "plain",
						operations: [
							{ id: "root-0", dataStore: "root" },
							{ id: "root-1", dataStore: "root" },
						],
					});
					s.sequence().operations("seq-plain", "alice", ["root-0", "root-1"], {
						batch: "plain",
						batchPosition: "single",
					});
				},
			);

			assertReports(scenario, "an ungrouped wire message carries exactly one");
		});
	});

	describe("invariant checkpoints", () => {
		it("backs every invariant name with a check that fires at the checkpoint", () => {
			for (const invariant of allTraceInvariants) {
				const probeCase = invariantProbes[invariant];
				const issues = validateScenario(probeCase.build());
				assert(
					issues.some(
						(issue) => issue.path !== "trace" && issue.message.includes(probeCase.fragment),
					),
					`Invariant '${invariant}' produced no checkpoint issue matching "${probeCase.fragment}". Got:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n") || "(none)"}`,
				);
			}
		});

		it("evaluates only the invariants a checkpoint names", () => {
			const build = (invariants: readonly TraceInvariant[]): FluidScenario =>
				scenarioOf("checkpoint scope", sources.loadModes, ["alice"], (s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("alice").submitOperation({ id: "first", dataStore: "root" });
					s.client("alice").submitOperation({ id: "second", dataStore: "root" });
					s.sequence().operations("seq-first", "alice", ["first"], { clientSequence: 4 });
					s.sequence().operations("seq-second", "alice", ["second"], { clientSequence: 4 });
					s.expectTrace().toSatisfy(invariants);
					s.expectOperation("never-declared").at("alice").toBe("processed");
				});

			const csnIssue = "does not advance within 'alice' current connection";
			const unrelated = messagesOf(build(["wireReconstruction"]));
			const related = messagesOf(build(["clientSequenceMonotonic"]));
			const indexOf = (messages: readonly string[], fragment: string): number =>
				messages.findIndex((message) => message.includes(fragment));
			const countOf = (messages: readonly string[]): number =>
				messages.filter((message) => message.includes(csnIssue)).length;

			assert.strictEqual(countOf(related), 1, "A violation must be reported exactly once.");
			assert.strictEqual(countOf(unrelated), 1, "A violation must be reported exactly once.");
			assert(
				indexOf(related, csnIssue) < indexOf(related, "Unknown operation"),
				"A checkpoint naming the relevant invariant reports it at that point in the timeline.",
			);
			assert(
				indexOf(unrelated, csnIssue) > indexOf(unrelated, "Unknown operation"),
				"A checkpoint naming an unrelated invariant defers the report to the final sweep.",
			);
		});
	});

	describe("lifecycle and provenance", () => {
		it("reports duplicate declarations and invalid detached submission in domain terms", () => {
			const invalidScenario = fluidScenario("invalid detached submit")
				.fromTest(sources.container)
				.document(document("collaboration", [root]))
				.clients(interactiveClient("alice"), interactiveClient("alice"))
				.covers("container-lifecycle", "op-stream")
				.steps((s) => {
					s.client("alice").createDetached();
					s.client("alice").submitOperation({ id: "op", dataStore: "root" });
				});

			const messages = messagesOf(invalidScenario);
			assert(messages.some((message) => message.includes("declared more than once")));
			assert(
				messages.some((message) =>
					message.includes("cannot submit runtime operations while detached"),
				),
			);
		});

		it("preserves attaching provenance through serialization and rehydration", () => {
			const scenario = fluidScenario("attaching serialization provenance")
				.fromTest({
					file: "packages/test/test-end-to-end-tests/src/test/serializeAfterFailedAttach.spec.ts",
					suite: "Serialize after failed attach",
					test: "Can serialize and rehydrate attaching container with no additional changes",
				})
				.document(document("collaboration", [root]))
				.clients(interactiveClient("attaching"), interactiveClient("rehydrated"))
				.covers("container-lifecycle", "container-load", "snapshot")
				.steps((s) => {
					s.client("attaching").createDetached();
					s.client("attaching").beginAttach();
					s.client("attaching").serialize("attaching-state");
					s.client("rehydrated").load({
						from: { kind: "serializedContainer", snapshot: "attaching-state" },
					});
					s.expectClient("rehydrated").toBe({ attach: "attached" });
				});

			assert.doesNotThrow(() => assertValidScenario(scenario));
		});

		it("rejects frozen loading from ordinary pending-local-state capture", () => {
			const scenario = fluidScenario("invalid frozen source")
				.fromTest({
					file: "packages/test/test-end-to-end-tests/src/test/offline/frozenOfflineRoundTrip.spec.ts",
					suite: "frozen container offline round-trip",
					test: "captureFullContainerState → offline writable load → re-capture → online resume",
				})
				.document(
					document("collaboration", [root], {
						flushMode: "turnBased",
						enableGroupedBatching: true,
						enableOfflineFull: true,
					}),
				)
				.clients(interactiveClient("online"), interactiveClient("offline"))
				.covers("container-load", "pending-state")
				.steps((s) => {
					s.client("online").load({ from: { kind: "service" } });
					s.client("online").capturePendingState("ordinary-pending-state");
					s.client("offline").load({
						from: {
							kind: "pendingState",
							pendingState: "ordinary-pending-state",
							mode: "frozen",
						},
					});
				});

			assertReports(scenario, "requires captureFullContainerState output");
		});

		it("rejects delivery to a frozen container", () => {
			const scenario = fluidScenario("delivery to a frozen container")
				.fromTest({
					file: "packages/test/test-end-to-end-tests/src/test/offline/frozenOfflineRoundTrip.spec.ts",
					suite: "frozen container offline round-trip",
					test: "captureFullContainerState → offline writable load → re-capture → online resume",
				})
				.document(
					document("collaboration", [root], {
						flushMode: "turnBased",
						enableGroupedBatching: true,
						enableOfflineFull: true,
					}),
				)
				.clients(interactiveClient("online"), interactiveClient("offline"))
				.covers("container-load", "op-ordering", "pending-state")
				.steps((s) => {
					s.client("online").load({ from: { kind: "service" } });
					s.service().captureFullContainerState("full-state");
					s.client("offline").load({
						from: { kind: "pendingState", pendingState: "full-state", mode: "frozen" },
					});
					s.client("online").submitOperation({ id: "edit", dataStore: "root" });
					s.sequence().operations("seq-edit", "online", ["edit"]);
					s.service().deliver("offline").through("latest");
				});

			assertReports(scenario, "loaded frozen and has no live op stream");
		});

		it("derives saved and stashed op counts from the trace rather than trusting the author", () => {
			const scenario = scenarioOf(
				"miscounted pending state",
				sources.stashedOps,
				["alice", "bob"],
				(s) => {
					s.client("alice").load({ from: { kind: "service" } });
					s.client("bob").load({ from: { kind: "service" } });
					s.client("bob").submitOperation({ id: "remote-edit", dataStore: "root" });
					s.sequence().operations("seq-remote", "bob", ["remote-edit"]);
					s.service().synchronize();
					s.client("alice").submitOperation({ id: "local-edit", dataStore: "root" });
					s.client("alice").capturePendingState("stash");
					s.expectPendingState("stash").toContain({ savedOps: 0, stashedOps: 0 });
				},
			);

			const messages = messagesOf(scenario);
			assert(
				messages.some((message) =>
					message.includes("captured 1 sequenced op(s) after its base snapshot, not 0"),
				),
				messages.join("\n"),
			);
			assert(
				messages.some((message) =>
					message.includes("captured 1 unsequenced local op(s), not 0"),
				),
				messages.join("\n"),
			);
		});
	});
});

/**
 * Never executed. These probes assert that illegal grammar fails to compile, which is part of
 * what the progressive interfaces are for.
 */
export function compileTimeGrammarProbes(): void {
	const sourceStage = fluidScenario("compile-time grammar");
	// @ts-expect-error A source test must be selected before the document can be declared.
	sourceStage.document(document("collaboration", [root]));

	const stepsStage = fluidScenario("compile-time client names")
		.fromTest(sources.container)
		.document(document("collaboration", [root]))
		.clients(interactiveClient("alice"))
		.covers("container-lifecycle");
	stepsStage.steps((s) => {
		// @ts-expect-error Client names are constrained to the declared literal identifiers.
		s.client("bob");
		// @ts-expect-error The sequencer only accepts declared client identifiers.
		s.sequence().operations("seq", "bob", ["edit"]);
		// @ts-expect-error Delivery cursors only accept declared client identifiers.
		s.service().deliver("bob");
	});
}
