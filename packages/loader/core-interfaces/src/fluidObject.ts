/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IProvideFluidConfiguration,
    IProvideFluidLoadable,
    IProvideFluidRunnable,
} from "./fluidLoadable";
import { IProvideFluidRouter } from "./fluidRouter";
import { IProvideFluidHandle, IProvideFluidHandleContext } from "./handles";
import { IProvideFluidSerializer } from "./serializer";

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface IFluidObject extends
    Readonly<Partial<
        IProvideFluidLoadable
        & IProvideFluidRunnable
        & IProvideFluidRouter
        & IProvideFluidHandleContext
        & IProvideFluidConfiguration
        & IProvideFluidHandle
        & IProvideFluidSerializer>> {
}

export interface FluidDataInterfaceCatalog extends
    Readonly<
        IProvideFluidLoadable
        & IProvideFluidRunnable
        & IProvideFluidRouter
        & IProvideFluidHandleContext
        & IProvideFluidConfiguration
        & IProvideFluidHandle
        & IProvideFluidSerializer> {
}

export type Queryable = {
    [P in keyof FluidDataInterfaceCatalog]: (u: unknown) => FluidDataInterfaceCatalog[P] | undefined;
};

const _catalog: { [t: string]: (u: any) => any } = {};

export const registerDataInterface = (t: string) => {
    _catalog[t] = (u: any) => u[t];
};

export const queryFor = _catalog as Queryable;

/* eslint-enable @typescript-eslint/no-empty-interface */
