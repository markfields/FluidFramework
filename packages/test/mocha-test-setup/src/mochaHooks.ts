/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryBufferedLogger } from "@fluidframework/test-driver-definitions";
import { ChildLogger } from "@fluidframework/telemetry-utils";

const _global: any = global;
const nullLogger: ITelemetryBufferedLogger = { send: () => {}, flush: async () => {} };

const log = console.log;
const error = console.log;
export const mochaHooks = {
    beforeAll() {
        // Ensure getTestLogger is defined
        const logger = _global.getTestLogger?.();
        if (logger === undefined) {
            _global.getTestLogger = () => nullLogger;
        } else {
            const props = {
                // Note - there are some tests which don't properly use the other mocha hook to initialize the driver
                hostName: () => `end-to-end tests (${getFluidTestDriver?.().type})`,
            };
            _global.getTestLogger =
                () => ChildLogger.create(logger, undefined, { all: props });
        }
    },
    beforeEach() {
        // Suppress console.log if not verbose mode
        if (process.env.FLUID_TEST_VERBOSE === undefined) {
            console.log = () => { };
            console.error = () => { };
        }
    },
    afterEach() {
        console.log = log;
        console.error = error;
    },
};
