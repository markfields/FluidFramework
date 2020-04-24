/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

// tslint:disable:completed-docs
// tslint:disable:mocha-no-side-effect-code

import { strict as assert } from "assert";
import { ComponentSerializer } from "../serializer";
import {
    handle,
    makeJson,
    mockHandleContext as context,
} from "./utils";

const serHandle = {
    type: "__fluid_handle__",
    url: "",
};

// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
function printHandle(target: any) {
    return JSON.stringify(target, (key, value) => {
        return value?.IComponentHandle !== undefined
            ? "#HANDLE"
            : value;
    });
}

// Start with the various JSON-serializable types
// eslint-disable-next-line no-null/no-null
const simple = [true, 1, "x", null, [], {}];

// Add an object where each field references one of the JSON serializable types.
simple.push(
    simple.reduce<any>(
        (o, value, index) => {
            o[`f${index}`] = value;
            return o;
        },
        {}));

// Add an array that contains each of our constructed test cases.
simple.push([...simple]);

const ser = new ComponentSerializer();

describe("ComponentSerializer", () => {
    function vanillaJson(replacer?, reviver?) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        describe(`vanilla JSON ${replacer ? "with replacer" : ""} ${reviver ? "with reviver" : ""}`, () => {
            // Verify that `replaceHandles` is a no-op for these simple cases.
            for (const input of simple) {
                it(`${printHandle(input)} -> ${JSON.stringify(input, replacer)}`, () => {
                    const actual = ser.replaceHandles(input, context, handle);
                    assert.equal(actual, input,
                        "replaceHandles() on input with no handles must return original input.");

                    const stringified = ser.stringify(input, context, handle, replacer);
                    const parsed = ser.parse(stringified, context, reviver);
                    assert.deepEqual(parsed, input,
                        "input must round-trip through stringify()/parse().");

                    // Paranoid check that ser.parse() and JSON.parse() agree.
                    assert.deepEqual(parsed, JSON.parse(stringified, reviver),
                        "parse() of input without handles must produce same result as JSON.parse().");
                });
            }

            it("replaceHandles() must round-trip undefined", () => {
                assert.equal(ser.replaceHandles(undefined, context, handle), undefined);
            });
        });
    }

    vanillaJson();
    // round-trip replacer/reviver pair
    vanillaJson(
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        (k, v) => k !== "nested" && !!v ? { nested: v } : v,  // replacer to nest every value in another object
        (k, v) => v?.nested ?? v,  // reviver to unwrap the nested value
    );

    function jsonWithHandles(replacer?, reviver?) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        describe(`JSON w/embedded handles ${replacer ? "with replacer" : ""} ${reviver ? "with reviver" : ""}`, () => {
            function check(input, expected) {
                it(`${printHandle(input)} -> ${JSON.stringify(expected)}`, () => {
                    const replaced = ser.replaceHandles(input, context, handle);
                    assert.notEqual(replaced, input,
                        "replaceHandles() must shallow-clone rather than mutate original object.");
                    assert.deepEqual(replaced, expected,
                        "replaceHandles() must return expected output.");

                    const stringified = ser.stringify(input, context, handle, replacer);

                    // Note that we're using JSON.parse() in this test, so the handles remained serialized.
                    assert.deepEqual(JSON.parse(stringified, reviver), expected,
                        "Round-trip through stringify()/JSON.parse() must produce the same output as replaceHandles()");

                    const parsed = ser.parse(stringified, context, reviver);
                    assert.deepEqual(parsed, input,
                        "input must round-trip through stringify()/parse().");
                });
            }

            check(handle, serHandle);
            check([handle], [serHandle]);
            check({ handle }, { handle: serHandle });
            check([{ handle }, { handle }], [{ handle: serHandle }, { handle: serHandle }]);
            check({ handle, some: { interesting: "data" } }, { handle: serHandle, some: { interesting: "data" } });

            //* todo: This is tricky.  Maybe they should just apply to handles i.e. compose naively.
            it(`Replace/Revive don't apply to handles`, () => {
                const valueToSerialize = handle;
                const stringified = ser.stringify(valueToSerialize, context, handle);
                const stringifiedWithReplacer = ser.stringify(valueToSerialize, context, handle, replacer);

                assert.deepStrictEqual(stringified, stringifiedWithReplacer,
                    "Replace shouldn't apply to handles");

                const parsed = ser.parse(stringifiedWithReplacer, context);
                const parsedWithReviver = ser.parse(stringifiedWithReplacer, context, reviver);
                assert.deepStrictEqual(parsed, parsedWithReviver,
                    "Revive shouldn't apply to handles");
            });

            it(`sizable json tree`, () => {
                const input: any = makeJson(
                    /* breadth: */ 4,
                    /* depth: */ 4,
                    /* createLeaf: */ () => ({ a: 0, b: handle, c: [handle, handle], d: false, e: handle }));

                // Add some handles to intermediate objects.
                input.h = handle;
                input.o1.h = handle;

                const replaced = ser.replaceHandles(input, context, handle);
                assert.notEqual(replaced, input,
                    "replaceHandles() must shallow-clone rather than mutate original object.");

                const stringified = ser.stringify(input, context, handle);
                const parsed = ser.parse(stringified, context);
                assert.deepEqual(parsed, input,
                    "input must round-trip through stringify()/parse().");
            });
        });
    }

    jsonWithHandles();
    // round-trip replacer/reviver pair
    jsonWithHandles(
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        (k, v) => k !== "nested" && !!v ? { nested: v } : v,  // replacer to nest every value in another object
        (k, v) => v?.nested ?? v,  // reviver to unwrap the nested value
    );
});
