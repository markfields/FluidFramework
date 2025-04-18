/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import { IFluidHandle } from "@fluidframework/core-interfaces";
import type { IEvent, IEventProvider } from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import { ISequencedDocumentMessage } from "@fluidframework/driver-definitions/internal";
import { ValueType, IFluidSerializer } from "@fluidframework/shared-object-base/internal";

import { makeSerializable } from "./IntervalCollectionValues.js";
import {
	IntervalCollection,
	opsMap,
	toOptionalSequencePlace,
	toSequencePlace,
	type ISerializedIntervalCollectionV1,
	type ISerializedIntervalCollectionV2,
} from "./intervalCollection.js";
import {
	IIntervalCollectionTypeOperationValue,
	IMapMessageLocalMetadata,
	ISerializableIntervalCollection,
	SequenceOptions,
} from "./intervalCollectionMapInterfaces.js";
import { getSerializedProperties } from "./intervals/index.js";

function isMapOperation(op: unknown): op is IMapOperation {
	return typeof op === "object" && op !== null && "type" in op && op.type === "act";
}

/**
 * Description of a map delta operation
 */
export interface IMapOperation {
	/**
	 * String identifier of the operation type.
	 */
	type: "act";

	/**
	 * Map key being modified.
	 */
	key: string;

	/**
	 * Value of the operation, specific to the value type.
	 */
	value: IIntervalCollectionTypeOperationValue;
}
/**
 * Defines the in-memory object structure to be used for the conversion to/from serialized.
 * Directly used in JSON.stringify, direct result from JSON.parse
 */
export interface IMapDataObjectSerializable {
	[key: string]: ISerializableIntervalCollection;
}

export interface IntervalCollectionMapEvents extends IEvent {
	(event: "createIntervalCollection", listener: (key: string, local: boolean) => void): void;
}

/**
 * A DefaultMap is a map-like distributed data structure, supporting operations on values stored by
 * string key locations.
 *
 * Creation of values is implicit on access (either via `get` or a remote op application referring to
 * a collection that wasn't previously known)
 */
export class IntervalCollectionMap {
	/**
	 * The number of key/value pairs stored in the map.
	 */
	public get size(): number {
		return this.data.size;
	}

	/**
	 * The in-memory data the map is storing.
	 */
	private readonly data = new Map<string, IntervalCollection>();

	private readonly eventEmitter = new TypedEventEmitter<IntervalCollectionMapEvents>();
	public get events(): IEventProvider<IntervalCollectionMapEvents> {
		return this.eventEmitter;
	}

	/**
	 * Create a new default map.
	 * @param serializer - The serializer to serialize / parse handles
	 * @param handle - The handle of the shared object using the kernel
	 * @param submitMessage - A callback to submit a message through the shared object
	 * @param type - The value type to create at values of this map
	 * @param eventEmitter - The object that will emit map events
	 */
	constructor(
		private readonly serializer: IFluidSerializer,
		private readonly handle: IFluidHandle,
		private readonly submitMessage: (
			op: IMapOperation,
			localOpMetadata: IMapMessageLocalMetadata,
		) => void,
		private readonly options?: Partial<SequenceOptions>,
	) {}

	/**
	 * Get an iterator over the keys in this map.
	 * @returns The iterator
	 */
	public keys(): IterableIterator<string> {
		return this.data.keys();
	}

	/**
	 * Get an iterator over the values in this map.
	 * @returns The iterator
	 */
	public values(): IterableIterator<any> {
		const localValuesIterator = this.data.values();
		const iterator = {
			next(): IteratorResult<any> {
				const nextVal = localValuesIterator.next();
				return nextVal.done
					? { value: undefined, done: true }
					: { value: nextVal.value, done: false }; // Unpack the stored value
			},
			[Symbol.iterator]() {
				return this;
			},
		};
		return iterator;
	}
	/**
	 * {@inheritDoc ISharedMap.get}
	 */
	public get(key: string): IntervalCollection {
		const localValue = this.data.get(key) ?? this.createCore(key, true);

		return localValue;
	}

	public serialize(serializer: IFluidSerializer): string {
		const serializableMapData: IMapDataObjectSerializable = {};
		this.data.forEach((localValue, key) => {
			serializableMapData[key] = makeSerializable(
				localValue,
				serializer,
				this.handle,
				this.options?.intervalSerializationFormat ?? "2",
			);
		});
		return JSON.stringify(serializableMapData);
	}

	/**
	 * Populate the kernel with the given map data.
	 *
	 * @param serialized - A JSON string containing serialized map data
	 */
	public populate(serialized: string): void {
		const parsed = this.serializer.parse(serialized) as IMapDataObjectSerializable;

		for (const [key, serializable] of Object.entries(parsed)) {
			// Back-compat: legacy documents may have handles to an intervalCollection map kernel.
			// These collections should be empty, and ValueTypes are no longer supported.
			if (
				serializable.type === ValueType[ValueType.Plain] ||
				serializable.type === ValueType[ValueType.Shared]
			) {
				continue;
			}

			// Back-compat: Sequence previously arbitrarily prefixed all interval collection keys with
			// "intervalCollections/". This would burden users trying to iterate the collection and
			// access its value, as well as those trying to match a create message to its underlying
			// collection. See https://github.com/microsoft/FluidFramework/issues/10557 for more context.
			const normalizedKey = key.startsWith("intervalCollections/") ? key.substring(20) : key;

			assert(
				serializable.type !== ValueType[ValueType.Plain] &&
					serializable.type !== ValueType[ValueType.Shared],
				0x2e1 /* "Support for plain value types removed." */,
			);

			this.createCore(normalizedKey, false, serializable.value);
		}
	}

	/**
	 * Submit the given op if a handler is registered.
	 * @param op - The operation to attempt to submit
	 * @param localOpMetadata - The local metadata associated with the op. This is kept locally by the runtime
	 * and not sent to the server. This will be sent back when this message is received back from the server. This is
	 * also sent if we are asked to resubmit the message.
	 * @returns True if the operation was submitted, false otherwise.
	 */
	public tryResubmitMessage(op: unknown, localOpMetadata: IMapMessageLocalMetadata): boolean {
		if (isMapOperation(op)) {
			const localValue = this.data.get(op.key);

			assert(localValue !== undefined, 0x3f8 /* Local value expected on resubmission */);

			const handler = opsMap[op.value.opName];
			const rebased = handler.rebase(localValue, op.value, localOpMetadata);
			if (rebased !== undefined) {
				const { rebasedOp, rebasedLocalOpMetadata } = rebased;
				this.submitMessage({ ...op, value: rebasedOp }, rebasedLocalOpMetadata);
			}
			return true;
		}
		return false;
	}

	public tryApplyStashedOp(op: unknown): boolean {
		if (isMapOperation(op)) {
			const { value, key } = op;
			const map = this.get(key);
			const { id, properties } = getSerializedProperties(value.value);

			switch (value.opName) {
				case "add": {
					map.add({
						id,
						// Todo: we should improve typing so we know add ops always have start and end
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						start: toSequencePlace(value.value.start!, value.value.startSide),
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						end: toSequencePlace(value.value.end!, value.value.endSide),
						props: properties,
					});
					return true;
				}
				case "change": {
					map.change(id, {
						start: toOptionalSequencePlace(value.value.start, value.value.startSide),
						end: toOptionalSequencePlace(value.value.end, value.value.endSide),
						props: properties,
					});
					return true;
				}
				case "delete": {
					map.removeIntervalById(id);
					return true;
				}
				default:
					throw new Error("unknown ops should not be stashed");
			}
		}
		return false;
	}

	/**
	 * Process the given op if a handler is registered.
	 * @param message - The message to process
	 * @param local - Whether the message originated from the local client
	 * @param localOpMetadata - For local client messages, this is the metadata that was submitted with the message.
	 * For messages from a remote client, this will be undefined.
	 * @returns True if the operation was recognized and thus processed, false otherwise.
	 *
	 * @remarks
	 * When this returns false and the caller doesn't handle the op itself, then the op could be from a different version of this code.
	 * In such a case, not applying the op would result in this client becoming out of sync with clients that do handle the op
	 * and could result in data corruption or data loss as well.
	 * Therefore, in such cases the caller should typically throw an error, ensuring that this client treats the situation as data corruption
	 * (since its data no longer matches what other clients think the data should be) and will avoid overriding document content or misleading the users into thinking their current state is accurate.
	 */
	public tryProcessMessage(
		op: unknown,
		local: boolean,
		message: ISequencedDocumentMessage,
		localOpMetadata: unknown,
	): boolean {
		if (isMapOperation(op)) {
			const localValue = this.data.get(op.key) ?? this.createCore(op.key, local);
			const handler = opsMap[op.value.opName];
			const previousValue = localValue;
			const translatedValue = op.value.value as any;
			handler.process(
				previousValue,
				translatedValue,
				local,
				message,
				localOpMetadata as IMapMessageLocalMetadata,
			);
			return true;
		}
		return false;
	}

	/**
	 * Initializes a default ValueType at the provided key.
	 * Should be used when a map operation incurs creation.
	 * @param key - The key being initialized
	 */
	private createCore(
		key: string,
		local: boolean,
		serializedIntervals?: ISerializedIntervalCollectionV1 | ISerializedIntervalCollectionV2,
	): IntervalCollection {
		const localValue = new IntervalCollection(
			(op, md) => {
				{
					this.submitMessage(
						{
							key,
							type: "act",
							value: op,
						},
						md,
					);
				}
			},
			serializedIntervals ?? [],
			this.options,
		);
		this.data.set(key, localValue);
		this.eventEmitter.emit("createIntervalCollection", key, local, this.eventEmitter);
		return localValue;
	}
}
