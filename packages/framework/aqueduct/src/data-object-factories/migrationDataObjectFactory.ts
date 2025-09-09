/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { FluidObject } from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import {
	DataStoreMessageType,
	FluidDataStoreRuntime,
	mixinRequestHandler,
} from "@fluidframework/datastore/internal";
import type { IChannelFactory } from "@fluidframework/datastore-definitions/internal";
import type {
	IFluidDataStoreChannel,
	IFluidDataStoreContext,
} from "@fluidframework/runtime-definitions/internal";
import type {
	AsyncFluidObjectProvider,
	FluidObjectSymbolProvider,
	IFluidDependencySynthesizer,
} from "@fluidframework/synthesize/internal";

import type { IDelayLoadChannelFactory } from "../channel-factories/index.js";
import type {
	DataObjectTypes,
	IDataObjectProps,
	ModelDescriptor,
} from "../data-objects/index.js";
import { PureDataObject } from "../data-objects/index.js";

import {
	PureDataObjectFactory,
	type DataObjectFactoryProps,
} from "./pureDataObjectFactory.js";

/**
 * Represents the properties required to create a MigrationDataObjectFactory.
 * @experimental
 * @legacy
 * @alpha
 */
export interface MigrationDataObjectFactoryProps<
	// Returned object type (must extend PureDataObject via base factory generic constraint, but not a special Migration class)
	TObj extends PureDataObject<I>,
	// Public interface / view type that callers program against (may be union implemented by different concrete classes)
	TUniversalView,
	I extends DataObjectTypes = DataObjectTypes,
	TNewModel extends TUniversalView = TUniversalView,
	TMigrationData = never,
> extends Omit<DataObjectFactoryProps<TObj, I>, "ctor"> {
	/**
	 * Full ordered list of model descriptors. First descriptor is the target/new (creation) model.
	 */
	readonly modelDescriptors: readonly [
		ModelDescriptor<TNewModel>,
		...ModelDescriptor<TUniversalView>[],
	];

	/**
	 * Given the selected descriptor (either probed existing or creation target), return the constructor
	 * to instantiate. Typically maps descriptor identity to a concrete PureDataObject subclass.
	 */
	readonly selectCtor: (
		descriptor: ModelDescriptor<TUniversalView>,
	) => new (
		props: IDataObjectProps<I>,
	) => TObj;

	/**
	 * Used for determining whether or not a migration can be performed based on providers and/or feature gates.
	 *
	 * An example might look like:
	 * ```
	 * async (providers) => {
	 *     const settingsProvider = await providers["SettingsProviders"];
	 *     return settingsProvider.getFeatureGate("myComponent.canMigrate");
	 * }
	 * ```
	 */
	canPerformMigration: (
		providers: AsyncFluidObjectProvider<I["OptionalProviders"]>,
	) => Promise<boolean>;

	/**
	 * Data required for running migration. This is necessary because the migration must happen synchronously.
	 *
	 * An example of what to asynchronously retrieve could be getting the "old" DDS that you want to migrate the data of:
	 * ```
	 * async (root) => {
	 *     root.get<IFluidHandle<SharedMap>>("mapKey").get();
	 * }
	 * ```
	 */
	asyncGetDataForMigration: (existingModel: TUniversalView) => Promise<TMigrationData>;

	/**
	 * Migrate the DataObject upon resolve (i.e. on retrieval of the DataStore).
	 *
	 * An example implementation could be changing which underlying DDS is used to represent the DataObject's data:
	 * ```
	 * (runtime, treeRoot, data) => {
	 *     // ! These are not all real APIs and are simply used to convey the purpose of this method
	 *     const mapContent = data.getContent();
	 *     const view = treeRoot.viewWith(treeConfiguration);
	 *     view.initialize(
	 *         new MyTreeSchema({
	 *             arbitraryMap: mapContent,
	 *         }),
	 *     );
	 *     view.dispose();
	 * }
	 * ```
	 * @param newModel - New model which is ready to be populated with the data
	 * @param data - Provided by the "asyncGetDataForMigration" function
	 */
	migrateDataObject: (
		runtime: FluidDataStoreRuntime,
		newModel: TNewModel,
		data: TMigrationData,
	) => void;

	/**
	 * If not provided, the Container will be closed after migration due to underlying changes affecting the data model.
	 */
	refreshDataObject?: () => Promise<void>;
}

/**
 * MigrationDataObjectFactory is the IFluidDataStoreFactory for migrating DataObjects.
 * See MigrationDataObjectFactoryProps for more information on how to utilize this factory.
 *
 * @experimental
 * @legacy
 * @alpha
 */
export class MigrationDataObjectFactory<
	TObj extends PureDataObject<I>,
	TUniversalView,
	I extends DataObjectTypes = DataObjectTypes,
	TNewModel extends TUniversalView = TUniversalView,
	TMigrationData = never,
> extends PureDataObjectFactory<TObj, I> {
	private migrateLock = false;
	private canPerformMigration: boolean | undefined;
	private readonly sharedObjectRegistryMap: Map<string, IChannelFactory>;

	// ! TODO: add new DataStoreMessageType.Conversion
	private static readonly conversionContent = "conversion";
	public constructor(
		private readonly props: MigrationDataObjectFactoryProps<
			TObj,
			TUniversalView,
			I,
			TNewModel,
			TMigrationData
		>,
	) {
		const runtimeClass = props.runtimeClass ?? FluidDataStoreRuntime;

		// Aggregate shared objects from all descriptors plus user-specified sharedObjects.
		//* TODO: Maybe we don't need to split by delay-loaded here (and in ModelDescriptor type)
		const aggregated = [...(props.sharedObjects ?? [])];
		const allFactories: {
			alwaysLoaded: Map<string, IChannelFactory>;
			delayLoaded: Map<string, IDelayLoadChannelFactory>;
		} = {
			alwaysLoaded: new Map<string, IChannelFactory>(),
			delayLoaded: new Map<string, IDelayLoadChannelFactory>(),
		};
		for (const curr of props.modelDescriptors) {
			for (const f of curr.sharedObjects.alwaysLoaded ?? []) {
				allFactories.alwaysLoaded.set(f.type, f);
			}
			for (const f of curr.sharedObjects.delayLoaded ?? []) {
				allFactories.delayLoaded.set(f.type, f);
			}
		}
		for (const f of allFactories.alwaysLoaded.values()) {
			if (!aggregated.some((x) => x.type === f.type)) {
				// User did not register this factory
				aggregated.push(f);
			}
		}
		for (const f of allFactories.delayLoaded.values()) {
			if (!aggregated.some((x) => x.type === f.type)) {
				aggregated.push(f);
			}
		}

		// Placeholder ctor not used; real instantiation handled in override.
		//* TODO: Would be nice to throw if it's used as-is
		const PlaceholderCtor = class extends PureDataObject<I> {} as unknown as new (
			p: IDataObjectProps<I>,
		) => TObj;
		super({
			type: props.type,
			ctor: PlaceholderCtor,
			sharedObjects: aggregated,
			optionalProviders: props.optionalProviders,
			registryEntries: props.registryEntries,
			runtimeClass,
			policies: props.policies,
		});
		this.sharedObjectRegistryMap = new Map(aggregated.map((f) => [f.type, f]));
	}

	public override async instantiateDataStore(
		context: IFluidDataStoreContext,
		existing: boolean,
	): Promise<IFluidDataStoreChannel> {
		// Compute migration eligibility if not yet done (mirrors observeCreateDataObject behavior)
		const scope: FluidObject<IFluidDependencySynthesizer> = context.scope;
		if (this.canPerformMigration === undefined) {
			const providersSynth =
				scope.IFluidDependencySynthesizer?.synthesize<I["OptionalProviders"]>(
					(this.props.optionalProviders as FluidObjectSymbolProvider<
						I["OptionalProviders"]
					>) ?? {},
					{},
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				) ?? ({} as AsyncFluidObjectProvider<never>);
			this.canPerformMigration = await this.props.canPerformMigration(providersSynth);
		}

		// Build providers (copy from createDataObject helper in base)
		const providers =
			scope.IFluidDependencySynthesizer?.synthesize<I["OptionalProviders"]>(
				(this.props.optionalProviders as FluidObjectSymbolProvider<I["OptionalProviders"]>) ??
					{},
				{},
			) ??
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			({} as AsyncFluidObjectProvider<never>);

		// We do not have direct runtimeClass property exposed; use provided runtimeClass from props or default.
		const runtimeClass = this.props.runtimeClass ?? FluidDataStoreRuntime;

		// Wrap runtime class with request handler mixin replicating base behavior.
		const mixedRuntimeClass = mixinRequestHandler(
			async (request, rt: FluidDataStoreRuntime) => {
				const inst = (await rt.entryPoint.get()) as TObj;
				assert(inst.request !== undefined, 0x795);
				return inst.request(request);
			},
			runtimeClass,
		);

		// Instance will be assigned once ctor chosen
		// eslint-disable-next-line prefer-const
		let instance: TObj | undefined; // allow single assignment post selection
		const runtime = new mixedRuntimeClass(
			context,
			new Map(this.sharedObjectRegistryMap),
			existing,
			async () => {
				assert(instance !== undefined, 0x46a);
				await instance.finishInitialization(true);
				return instance;
			},
			this.props.policies,
		);

		const [targetDescriptor, ...otherDescriptors] = this.props.modelDescriptors;
		let chosenDescriptor: ModelDescriptor<TUniversalView> | ModelDescriptor<TNewModel> =
			targetDescriptor;
		let existingDescriptor: ModelDescriptor<TUniversalView> | undefined;
		let existingModelView: TUniversalView | undefined;

		if (existing) {
			// Probe for existing descriptor
			const maybeTarget = await targetDescriptor.probe(runtime).catch(() => undefined);
			if (maybeTarget) {
				existingDescriptor = targetDescriptor;
				existingModelView = maybeTarget;
			} else {
				for (const desc of otherDescriptors) {
					const maybe = await desc.probe(runtime).catch(() => undefined);
					if (maybe !== undefined) {
						existingDescriptor = desc;
						existingModelView = maybe;
						break;
					}
				}
				assert(
					existingDescriptor !== undefined && existingModelView !== undefined,
					"Unable to match runtime structure to any known data model",
				);
			}

			// Decide on migration
			if (
				this.canPerformMigration &&
				existingDescriptor !== targetDescriptor &&
				!this.migrateLock
			) {
				this.migrateLock = true;
				try {
					const targetFactoriesP = targetDescriptor.ensureFactoriesLoaded();
					if (existingModelView === undefined) {
						throw new Error("Existing model view disappeared during migration");
					}
					const data = await this.props.asyncGetDataForMigration(existingModelView);
					await targetFactoriesP;
					runtime.submitMessage(
						DataStoreMessageType.ChannelOp,
						MigrationDataObjectFactory.conversionContent,
						undefined,
					);
					// Create channels for target model
					const newModel = targetDescriptor.create(runtime);
					this.props.migrateDataObject(runtime, newModel, data);
					chosenDescriptor = targetDescriptor;
				} finally {
					this.migrateLock = false;
				}
			} else {
				if (existingDescriptor !== undefined) {
					chosenDescriptor = existingDescriptor;
				}
			}
		} else {
			await targetDescriptor.ensureFactoriesLoaded();
			targetDescriptor.create(runtime); // Create initial model structure
			chosenDescriptor = targetDescriptor;
		}

		// Instantiate concrete data object for chosen descriptor
		const Ctor = this.props.selectCtor(chosenDescriptor as ModelDescriptor<TUniversalView>);
		instance = new Ctor({ runtime, context, providers, initProps: undefined });
		if (!existing) {
			await instance.finishInitialization(false);
		}
		return runtime;
	}
}
