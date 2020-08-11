/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    DataObject,
    DataObjectFactory,
} from "@fluidframework/aqueduct";

export interface ISmokeTester {
    run(): Promise<void>;
}

export class SmokeTester extends DataObject implements ISmokeTester {
    public static Name: string = "SmokeTester";

    public async run(): Promise<void> {
        throw new Error("Method not implemented.");
    }
}

export const SmokeTesterFactory = new DataObjectFactory(
    SmokeTester.Name,
    SmokeTester,
    [],
    {},
);
