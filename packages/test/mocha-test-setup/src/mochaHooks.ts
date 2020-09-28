/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable @typescript-eslint/unbound-method */
const log = console.log;
const error = console.error;
if (process.env.FLUID_TEST_VERBOSE === undefined) {
    console.log(`
NOTE: console.log and console.error are suppressed.
      set FLUID_TEST_VERBOSE env var to 1 to enable,
      or use :verbose version of test script if present in package.json`);
}
export const mochaHooks = {
    beforeEach() {
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
