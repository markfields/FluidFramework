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
export type IFluidObject = Partial<FluidDataInterfaceCatalog>;

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
/* eslint-enable @typescript-eslint/no-empty-interface */

// /////////////////////////
// Option 1
// (obj as IFluidObject).queryFor?.IFoo
// /////////////////////////
export interface IFluidObject1 {
    queryFor?: Partial<FluidDataInterfaceCatalog>;
}

export interface Queryable<T> { // T should be an IProvide interface
    queryFor: T;
}

// /////////////////////////
// Option 2
// queryObject(obj).forInterface.IFoo
// /////////////////////////
export interface QueryableObject2 {
    forInterface: Partial<FluidDataInterfaceCatalog>;
}

export function queryObject2(o: any) {
    if (o.forInterface === undefined) {
        o.forInterface = {};
    }
    return o as QueryableObject2;
}

// /////////////////////////
// Option 3
// queryObject(obj).forInterface(IFoo)
// DOES NOT WORK - forInterface3 can't return the specialized type
// /////////////////////////

export interface QueryableObject3 {
    forInterface: (interfaceName: keyof FluidDataInterfaceCatalog) => any;
}

export function queryObject3(o: any) {
    o.forInterface = (interfaceName: keyof FluidDataInterfaceCatalog) => o[interfaceName];
    return o as QueryableObject3;
}

// /////////////////////////
// Option 4
// queryObject(obj).IFoo
// /////////////////////////

export type IFluidObject4 = IFluidObject;

export const queryObject4 = (o: any) => o as IFluidObject4;
