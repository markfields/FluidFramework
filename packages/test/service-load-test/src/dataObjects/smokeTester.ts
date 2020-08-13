/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    DataObject,
    DataObjectFactory,
} from "@fluidframework/aqueduct";
import { SmokeTestProfile } from "../testProfiles";

export interface ISmokeTestRunConfig {
    runId: number,
    testProfile: SmokeTestProfile
}

export interface ISmokeTester {
    run(config: ISmokeTestRunConfig): Promise<void>;
}

export class SmokeTester extends DataObject implements ISmokeTester {
    public static Name: string = "SmokeTester";

    public async run(config: ISmokeTestRunConfig): Promise<void> {
        throw new Error("Method not implemented.");
    }
}

export const SmokeTesterFactory = new DataObjectFactory(
    SmokeTester.Name,
    SmokeTester,
    [],
    {},
);
