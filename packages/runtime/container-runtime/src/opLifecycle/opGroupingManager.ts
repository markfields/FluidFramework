/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { ContainerMessageType, ToJsonString } from "../messageTypes";
import { IBatch } from "./definitions";

/**
 * Grouping makes assumptions about the shape of message contents. This interface codifies those assumptions, but does not validate them.
 */
interface IGroupedBatchMessageContents {
	type: typeof OpGroupingManager.groupedBatchOp;
	contents: IGroupedMessage[];
}

export interface IGroupedMessage {
	contents?: unknown;
	metadata?: Record<string, unknown>;
	compression?: string;
}

function isGroupContents(
	opContents: IGroupedBatchMessageContents | { type?: unknown } | undefined,
): opContents is IGroupedBatchMessageContents {
	return opContents?.type === OpGroupingManager.groupedBatchOp;
}

export class OpGroupingManager {
	public static readonly groupedBatchOp = "groupedBatch" as const;

	constructor(private readonly groupedBatchingEnabled: boolean) {}

	public groupBatch(batch: IBatch): IBatch {
		if (batch.content.length < 2 || !this.groupedBatchingEnabled) {
			return batch;
		}

		for (const message of batch.content) {
			if (message.metadata) {
				const keys = Object.keys(message.metadata);
				assert(keys.length < 2, 0x5dd /* cannot group ops with metadata */);
				assert(
					keys.length === 0 || keys[0] === "batch",
					0x5de /* unexpected op metadata */,
				);
			}
		}

		const serializedContent = ToJsonString({
			type: OpGroupingManager.groupedBatchOp,
			contents: batch.content.map<IGroupedMessage>((message) => ({
				contents: message.contents === undefined ? undefined : JSON.parse(message.contents),
				metadata: message.metadata,
				compression: message.compression,
			})),
		});

		const groupedBatch: IBatch = {
			...batch,
			content: [
				{
					localOpMetadata: undefined,
					metadata: undefined,
					referenceSequenceNumber: batch.content[0].referenceSequenceNumber,
					contents: serializedContent,
					type: OpGroupingManager.groupedBatchOp as ContainerMessageType,
				},
			],
		};
		return groupedBatch;
	}

	public ungroupOp(op: ISequencedDocumentMessage): ISequencedDocumentMessage[] {
		if (!isGroupContents(op.contents)) {
			return [op];
		}

		const messages: IGroupedMessage[] = op.contents.contents;
		let fakeCsn = 1;
		//* I think we can do better than unknown for contents.  Where/What is type?
		return messages.map(({ contents, metadata, compression }) => ({
			...op,
			contents,
			metadata,
			compression,
			clientSequenceNumber: fakeCsn++,
		}));
	}
}
