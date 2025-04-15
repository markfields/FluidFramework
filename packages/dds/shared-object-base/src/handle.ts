/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IFluidHandleContext } from "@fluidframework/core-interfaces/internal";
import { FluidObjectHandle } from "@fluidframework/datastore/internal";

import { ISharedObject } from "./types.js";

/**
 * Handle for a shared object.
 *
 * @remarks
 *
 * This object is used for already loaded (in-memory) shared objects and is used only for serialization purposes.
 *
 * De-serialization process goes through {@link @fluidframework/datastore#FluidObjectHandle}, and request flow:
 * {@link @fluidframework/datastore#FluidDataStoreRuntime.request} recognizes requests in the form of
 * '/\<shared object id\>' and loads shared object.
 */
export class SharedObjectHandle extends FluidObjectHandle<ISharedObject> {
	/**
	 * Whether services have been attached for the associated shared object.
	 */
	public get isAttached(): boolean {
		// Access broker via the getter from the base class
		return this.broker.isAttached;
	}

	/**
	 * Creates a new SharedObjectHandle.
	 * @param value - The shared object this handle is for.
	 * @param path - The id of the shared object. It is also the path to this object relative to the routeContext.
	 * @param routeContext - The parent {@link @fluidframework/core-interfaces#IFluidHandleContext} that has a route
	 * to this handle.
	 * @param broker - The broker associated with the shared object.
	 */
	constructor(
		protected readonly value: ISharedObject,
		path: string,
		routeContext: IFluidHandleContext,
		broker: ChannelAttachBroker, // Keep broker parameter
	) {
		// Pass the broker to the super constructor
		super(value, path, routeContext, broker);
	}

	// No need to override 'isAttached' or 'broker' as the base class handles it.

	// No need to override 'attachGraph' as the base class handles deprecation.

	// No need to override 'bind' as the base class handles deprecation.
}
