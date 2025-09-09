/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	IFluidDataStoreRuntime,
	IChannelFactory,
} from "@fluidframework/datastore-definitions/internal";

import type { IDelayLoadChannelFactory } from "../channel-factories/index.js";

import { PureDataObject } from "./pureDataObject.js";
import type { DataObjectTypes } from "./types.js";

/**
 * Descriptor for a model shape (arbitrary schema) the migration data object can probe for
 * or create when initializing. The probe function may inspect multiple channels or other
 * runtime state to determine whether the model exists and return a model instance.
 * @legacy
 * @alpha
 */
export interface ModelDescriptor<TModel = unknown> {
	//* Consider if we want something more formal here or if "duck typing" the runtime channel structure is sufficient.
	//* See Craig's DDS shim branch for an example of tagging migrations
	// Probe runtime for an existing model based on which channels exist. Return the model instance or undefined if not found.
	probe: (runtime: IFluidDataStoreRuntime) => Promise<TModel | undefined>;
	/**
	 * Load any delay-loaded factories needed for this model.
	 *
	 * @remarks
	 * This must be called before create can be called - otherwise the factory may be missing!
	 */
	ensureFactoriesLoaded: () => Promise<void>;
	/**
	 * Synchronously create the model.
	 * @remarks
	 * Any delay-loaded factories must already have been loaded via ModelDescriptor.loadFactories.
	 */
	create: (runtime: IFluidDataStoreRuntime) => TModel;
	/**
	 * The factories needed for this Data Model, divided by whether they are always loaded or delay-loaded
	 */
	sharedObjects: {
		//* Do we need to split these apart or just have IChannelFactory[]?
		alwaysLoaded?: IChannelFactory[];
		delayLoaded?: IDelayLoadChannelFactory[];
	};
	// Optional runtime type guard to help callers narrow model types.
	//* Probably remove?  Copilot added it
	is?: (m: unknown) => m is TModel;
}

/**
 * This base class provides an abstraction between a Data Object's internal data access API
 * and the underlying Fluid data model.  Any number of data models may be supported, for
 * perma-back-compat scenarios where the component needs to be ready to load any version
 * from data at rest.
 * @experimental
 * @legacy
 * @alpha
 */
/**
 * @deprecated MigrationDataObject no longer performs model probing. Logic has moved into MigrationDataObjectFactory.
 * Retained as a no-op base for transitional compatibility; prefer extending PureDataObject directly.
 * @legacy @alpha
 */
export abstract class MigrationDataObject<
	TUniversalView,
	I extends DataObjectTypes = DataObjectTypes,
> extends PureDataObject<I> {
	// Kept for source compatibility; always undefined.
	public get dataModel(): undefined {
		return undefined;
	}
}
