/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { FluidObject } from "@fluidframework/core-interfaces";
import type { IFluidHandleInternal } from "@fluidframework/core-interfaces/internal";
import { IFluidHandleContext } from "@fluidframework/core-interfaces/internal";
import {
	generateHandleContextPath,
	FluidHandleBase,
} from "@fluidframework/runtime-utils/internal";

import type { ChannelAttachBroker } from "./channelAttachBroker.js";

/**
 * Handle for a shared {@link @fluidframework/core-interfaces#FluidObject}.
 * @legacy
 * @alpha
 */
export class FluidObjectHandle<
	T extends FluidObject = FluidObject,
> extends FluidHandleBase<T> {
	/**
	 * {@inheritDoc @fluidframework/core-interfaces#IFluidHandle.absolutePath}
	 */
	public readonly absolutePath: string;

	/**
	 * {@inheritDoc @fluidframework/core-interfaces#IFluidHandle.isAttached}
	 */
	public get isAttached(): boolean {
		// Use the broker getter which handles fallback
		return this.broker.isAttached;
	}

	/**
	 * Creates a new `FluidObjectHandle`.
	 *
	 * @param value - The {@link @fluidframework/core-interfaces#FluidObject} object this handle is for.
	 * @param path - The path to this handle relative to the `routeContext`.
	 * @param routeContext - The parent {@link @fluidframework/core-interfaces#IFluidHandleContext} that has a route
	 * to this handle.
	 * @param broker - Optional: The ChannelAttachBroker associated with the object.
	 */
	constructor(
		protected readonly value: T | Promise<T>,
		public readonly path: string,
		public readonly routeContext: IFluidHandleContext,
		broker?: ChannelAttachBroker, //* Make required
	) {
		//*
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		super(broker!);
		this.absolutePath = generateHandleContextPath(path, this.routeContext);
	}

	/**
	 * {@inheritDoc @fluidframework/core-interfaces#IFluidHandle.get}
	 */
	public async get(): Promise<any> {
		// Note that this return works whether we received a T or a Promise<T> for this.value in the constructor.
		return this.value;
	}

	/**
	 * {@inheritDoc @fluidframework/core-interfaces#IFluidHandle.attachGraph }
	 * @deprecated Replaced by broker attach propagation.
	 */
	public attachGraph(): void {
		console.warn("FluidObjectHandle.attachGraph() called - check if still needed.");
		// Original logic related to pendingHandlesToMakeVisible and routeContext.attachGraph()
		// is likely superseded by broker propagation. Making this a no-op for now.

		// if (this.visible) {
		// 	return;
		// }
		// this.locallyVisible = true;
		// this.pendingHandlesToMakeVisible.forEach((handle) => {
		// 	handle.attachGraph();
		// });
		// this.pendingHandlesToMakeVisible.clear();
		// this.routeContext.attachGraph();
	}

	/**
	 * {@inheritDoc @fluidframework/core-interfaces#IFluidHandleInternal.bind}
	 * @deprecated Replaced by broker reference tracking.
	 */
	public bind(handle: IFluidHandleInternal): void {
		console.warn("FluidObjectHandle.bind() called - should use brokers instead.");
		// Original logic related to pendingHandlesToMakeVisible is superseded by broker.addReference.
		// Making this a no-op for now.

		// if (this.visible) {
		// 	handle.attachGraph();
		// 	return;
		// }
		// this.pendingHandlesToMakeVisible.add(handle);
	}
}
