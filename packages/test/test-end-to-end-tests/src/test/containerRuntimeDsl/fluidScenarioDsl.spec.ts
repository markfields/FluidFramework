/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";

import { document, fluidScenario, interactiveClient } from "./builder.js";
import { containerRuntimeDslScenarios } from "./scenarios.js";
import { assertValidScenario, validateScenario } from "./validator.js";

describe("Fluid Container Runtime collaboration DSL", () => {
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
			"op-virtualization",
			"pending-state",
			"snapshot",
			"summarization",
			"data-virtualization",
		] as const) {
			assert(actualCoverage.has(required), `Missing coverage for ${required}`);
		}
	});

	it("produces a pure serializable semantic model", () => {
		for (const scenario of containerRuntimeDslScenarios) {
			const roundTripped = JSON.parse(JSON.stringify(scenario));
			assert.deepStrictEqual(roundTripped, scenario);
		}
	});

	it("reports duplicate declarations and invalid detached submission in domain terms", () => {
		const invalidScenario = fluidScenario("invalid detached submit")
			.fromTest({
				file: "packages/test/test-end-to-end-tests/src/test/container.spec.ts",
				suite: "Container",
				test: "invalid example",
			})
			.document(document("collaboration", [{ id: "root", root: true }]))
			.clients(interactiveClient("alice"), interactiveClient("alice"))
			.covers("container-lifecycle", "op-stream")
			.steps((s) => {
				s.client("alice").createDetached();
				s.client("alice").submitOperation({ id: "op", dataStore: "root" });
			});

		const messages = validateScenario(invalidScenario).map((issue) => issue.message);
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
			.document(document("collaboration", [{ id: "root", root: true }]))
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
				suite: "Frozen offline pending-state round trip",
				test: "invalid example",
			})
			.document(
				document("collaboration", [{ id: "root", root: true }], {
					flushMode: "turnBased",
					enableGroupedBatching: true,
					enableBatchIdTracking: true,
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

		assert(
			validateScenario(scenario).some((issue) =>
				issue.message.includes("requires captureFullContainerState output"),
			),
		);
	});
});

if (false) {
	const sourceStage = fluidScenario("compile-time grammar");
	// @ts-expect-error A source test must be selected before the document can be declared.
	sourceStage.document(document("collaboration", [{ id: "root", root: true }]));

	const stepsStage = fluidScenario("compile-time client names")
		.fromTest({
			file: "packages/test/test-end-to-end-tests/src/test/container.spec.ts",
			suite: "Container",
			test: "compile-time example",
		})
		.document(document("collaboration", [{ id: "root", root: true }]))
		.clients(interactiveClient("alice"))
		.covers("container-lifecycle");
	stepsStage.steps((s) => {
		// @ts-expect-error Client names are constrained to the declared literal identifiers.
		s.client("bob");
	});
}
