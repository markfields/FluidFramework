/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IEvent, IEventProvider } from "@fluidframework/core-interfaces";
import type { IFluidLoadable, IFluidHandleInternal } from "@fluidframework/core-interfaces/internal";
import type { IChannel } from "@fluidframework/datastore-definitions/internal";
import type { ChannelAttachBroker } from "@fluidframework/datastore-definitions/internal";

/**
 * Base interface for shared objects from which other interfaces derive.
 * @legacy
 * @alpha
 */
export interface ISharedObject<TEvent extends ISharedObjectEvents = ISharedObjectEvents>
	extends IChannel,
		IFluidLoadable,
		IProvideFluidHandle, // eslint-disable-line @typescript-eslint/no-empty-interface
		IEventProvider<TEvent> {
	/**
	 * Binds the given shared object to its containing data store runtime, causing it to attach.
	 *
	 * @remarks
	 *
	 * This includes registering the object in the runtime registry and attaching it to the delta manager.
	 *
	 * This method should only be called by the data store runtime.
	 */
	bindToContext(): void;

	/**
	 * The broker responsible for managing the attachment state of this shared object.
	 * @internal
	 */
	readonly broker: ChannelAttachBroker;
}

/**
 * Events emitted by {@link ISharedObject}.
 * @legacy
 * @alpha
 */
export interface ISharedObjectEvents extends IErrorEvent {
	/**
	 * Fires before an incoming operation (op) is applied to the shared object.
	 *
	 * @remarks Note: this should be considered an internal implementation detail. It is not recommended for external
	 * use.
	 *
	 * @eventProperty
	 */
	(
		event: "pre-op",
		listener: (
			op: ISequencedDocumentMessage,
			local: boolean,
			target: IEventThisPlaceHolder,
		) => void,
	);

	/**
	 * Fires after an incoming op is applied to the shared object.
	 *
	 * @remarks Note: this should be considered an internal implementation detail. It is not recommended for external
	 * use.
	 *
	 * @eventProperty
	 */
	(
		event: "op",
		listener: (
			op: ISequencedDocumentMessage,
			local: boolean,
			target: IEventThisPlaceHolder,
		) => void,
	);
}
