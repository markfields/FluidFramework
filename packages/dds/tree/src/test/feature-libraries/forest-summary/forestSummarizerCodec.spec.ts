/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { validateAssertionError } from "@fluidframework/test-runtime-utils";
import { rootFieldKey } from "../../../core/index.js";
import {
	TreeCompressionStrategy,
	cursorForJsonableTreeField,
	makeFieldBatchCodec,
} from "../../../feature-libraries/index.js";

import {
	FieldSet,
	makeForestSummarizerCodec,
	// eslint-disable-next-line import/no-internal-modules
} from "../../../feature-libraries/forest-summary/codec.js";
import { emptySchema } from "../../cursorTestSuite.js";
// eslint-disable-next-line import/no-internal-modules
import { Format, version } from "../../../feature-libraries/forest-summary/format.js";
// eslint-disable-next-line import/no-internal-modules
import { TreeChunk } from "../../../feature-libraries/chunked-forest/index.js";
import {
	chunkField,
	defaultChunkPolicy,
	// eslint-disable-next-line import/no-internal-modules
} from "../../../feature-libraries/chunked-forest/chunkTree.js";
import { brand } from "../../../util/index.js";
import { ICodecOptions } from "../../../codec/index.js";
import { typeboxValidator } from "../../../external-utilities/index.js";

const codecOptions: ICodecOptions = { jsonValidator: typeboxValidator };
const fieldBatchCodec = makeFieldBatchCodec(codecOptions, {
	encodeType: TreeCompressionStrategy.Uncompressed,
});

const codec = makeForestSummarizerCodec(codecOptions, fieldBatchCodec);

const testFieldChunks: TreeChunk[] = chunkField(
	cursorForJsonableTreeField([{ type: emptySchema.name }]),
	defaultChunkPolicy,
);
assert(testFieldChunks.length === 1);
const testFieldChunk: TreeChunk = testFieldChunks[0];

const malformedData: [string, any][] = [
	[
		"additional piece of data in entry",
		new Map([[rootFieldKey, [testFieldChunk.cursor(), "additional data"]]]),
	],
	["incorrect data type", ["incorrect data type"]],
];
const validData: [string, FieldSet, Format | undefined][] = [
	[
		"no entry",
		new Map(),
		{
			version,
			keys: [],
			fields: fieldBatchCodec.encode([]),
		},
	],
	[
		"single entry",
		new Map([[rootFieldKey, testFieldChunk.cursor()]]),
		{
			version,
			keys: [rootFieldKey],
			fields: fieldBatchCodec.encode([testFieldChunk.cursor()]),
		},
	],
	[
		"multiple entries",
		new Map([
			[rootFieldKey, testFieldChunk.cursor()],
			[brand("X"), testFieldChunk.cursor()],
		]),
		undefined,
	],
];

describe("ForestSummarizerCodec", () => {
	describe("encodes and decodes valid data.", () => {
		for (const [name, data, expected] of validData) {
			it(name, () => {
				const encodedData = codec.encode(data);
				if (expected !== undefined) {
					assert.deepEqual(encodedData, expected);
				}

				const decodedData = codec.decode(encodedData);
				assert.deepEqual(decodedData, data);
			});
		}
	});

	describe("throws on receiving malformed data during encode.", () => {
		for (const [name, data] of malformedData) {
			it(name, () => {
				assert.throws(() => codec.encode(data as unknown as FieldSet), "malformed data");
			});
		}
	});

	describe("throws on receiving malformed data during decode.", () => {
		it("invalid version", () => {
			assert.throws(
				() =>
					codec.decode({
						version: 2.0 as number as 1.0,
						fields: { version: 1 },
						keys: [],
					}),
				(e: Error) => validateAssertionError(e, "version being decoded is not supported"),
			);
		});

		it("invalid nested version", () => {
			assert.throws(
				() =>
					codec.decode({
						version: 1.0,
						fields: { version: 2 },
						keys: [],
					}),
				(e: Error) => validateAssertionError(e, "version being decoded is not supported"),
			);
		});

		it("missing fields", () => {
			assert.throws(
				() =>
					codec.decode({
						version: 1.0,
						keys: [],
					} as unknown as Format),
				(e: Error) => validateAssertionError(e, "Encoded schema should validate"),
			);
		});

		it("extra field", () => {
			assert.throws(
				() =>
					codec.decode({
						version: 1.0,
						fields: { version: 1 },
						keys: [],
						wrong: 5,
					} as unknown as Format),
				(e: Error) => validateAssertionError(e, "Encoded schema should validate"),
			);
		});
	});
});