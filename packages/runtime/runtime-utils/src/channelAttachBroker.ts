/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type { IChannelAttachBroker } from "@fluidframework/core-interfaces/internal";
import type {
	IChannel,
	IFluidDataStoreRuntime,
} from "@fluidframework/datastore-definitions/internal";

/**
 * Events emitted by a ChannelAttachBroker.
 * @internal
 */
export type IChannelAttachBrokerEvents =
	/**
	 * Emitted when a new outbound reference is added from this broker to a target broker.
	 * This happens during serialization when a handle is encoded.
	 */
	(event: "referenceAdded", listener: (targetBroker: ChannelAttachBroker) => void) => void;

/**
 * Manages the attachment relationship and propagation for a specific channel (DDS or DataStore).
 * Brokers form a graph based on references (e.g., storing a handle). When a broker becomes attached,
 * it automatically triggers the attachment of brokers it references, if they are not already attached.
 * @internal
 */
export class ChannelAttachBroker
	extends TypedEventEmitter<IChannelAttachBrokerEvents>
	implements IChannelAttachBroker
{
	private _isAttached: boolean;
	public readonly referencedBrokers = new Set<ChannelAttachBroker>();

	/**
	 * Creates an instance of ChannelAttachBroker.
	 * @param object - The channel (DDS or DataStore) this broker is associated with.
	 * @param containingDataStore - The runtime of the data store that contains this broker's channel.
	 * @param attachFn - The function to call to physically attach the associated channel.
	 * This function is responsible for eventually calling `setAttached()` on this broker.
	 * @param initialAttachedState - The initial attachment state of the channel.
	 */
	constructor(
		public readonly object: IChannel, // TODO: Consider a more specific type? IFluidLoadable?
		public readonly containingDataStore: IFluidDataStoreRuntime,
		private readonly attachFn: (sourceDataStore: IFluidDataStoreRuntime) => void,
		initialAttachedState: boolean,
	) {
		super();
		this._isAttached = initialAttachedState;
	}

	/**
	 * Indicates whether the channel associated with this broker is considered attached.
	 */
	public get isAttached(): boolean {
		return this._isAttached;
	}

	/**
	 * Marks the associated channel as attached and propagates attachment to referenced brokers.
	 * This should be called by the `attachFn` or the channel's attachment logic completion.
	 */
	public setAttached(): void {
		if (!this._isAttached) {
			this._isAttached = true;
			// When attached, trigger attach on referenced brokers that are not yet attached.
			this.referencedBrokers.forEach((targetBroker) => {
				//* Let the target early return if it is already attached.
				if (!targetBroker.isAttached) {
					// Pass the DataStore of the *current* broker as the source
					targetBroker.attach(this.containingDataStore);
				}
			});
		}
	}

	/**
	 * Initiates the attachment process for the associated channel.
	 * If the channel is already attached, this is a no-op.
	 * @param sourceDataStore - The data store runtime associated with the broker that triggered this attachment.
	 */
	public attach(sourceDataStore: IFluidDataStoreRuntime): void {
		if (!this._isAttached) {
			// Call the actual attach implementation provided in the constructor.
			// It is expected that the attachFn will eventually call setAttached() on this broker.
			this.attachFn(sourceDataStore);
		}
	}

	/**
	 * Adds a reference from this broker's channel to the target broker's channel.
	 * This is typically called during serialization when a handle is encountered.
	 * If the current broker is already attached, this will immediately trigger attachment on the target broker.
	 * @param targetBroker - The broker for the channel being referenced.
	 */
	public addReference(targetBroker: ChannelAttachBroker): void {
		if (!this.referencedBrokers.has(targetBroker)) {
			this.referencedBrokers.add(targetBroker);
			this.emit("referenceAdded", targetBroker);

			// If the source broker (this) is already attached, immediately try to attach the target.
			if (this.isAttached && !targetBroker.isAttached) {
				// Pass the DataStore of the *source* broker (this) as the source
				targetBroker.attach(this.containingDataStore);
			}
		}
	}
}
