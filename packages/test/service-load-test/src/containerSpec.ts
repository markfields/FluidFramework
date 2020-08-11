/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ContainerRuntimeFactoryWithDefaultDataStore } from "@fluidframework/aqueduct";
import { LoadTester, LoadTesterFactory } from "./dataObjects/loadTester";
import { SmokeTester, SmokeTesterFactory } from "./dataObjects/smokeTester";

export const fluidExport = new ContainerRuntimeFactoryWithDefaultDataStore(
    LoadTester.Name,
    new Map([
        [LoadTester.Name, Promise.resolve(LoadTesterFactory)],
        [SmokeTester.Name, Promise.resolve(SmokeTesterFactory)],
    ]),
);
