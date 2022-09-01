/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable max-len */

import { EventEmitter, Listener } from "events";
import {
    IEvent,
    TransformedEvent,
    IEventTransformer,
    IEventProvider,
} from "@fluidframework/common-definitions";

/**
 * The event emitter polyfill and the node event emitter have different event types:
 * string | symbol vs. string | number
 *
 * This type allow us to correctly handle either type
 */
export type EventEmitterEventType = EventEmitter extends { on(event: infer E, listener: any) }
    ? E
    : never;

export type TypedEventTransform<TThis, TEvent> =
    // Event emitter supports some special events for the emitter itself to use
    // this exposes those events for the TypedEventEmitter.
    // Since we know what the shape of these events are, we can describe them directly via a TransformedEvent
    // which easier than trying to extend TEvent directly
    TransformedEvent<
        TThis,
        "newListener" | "removeListener",
        Parameters<(event: string, listener: (...args: any[]) => void) => void>
    > &
        // Expose all the events provides by TEvent
        IEventTransformer<TThis, TEvent & IEvent> &
        // Add the default overload so this is covertable to EventEmitter regardless of environment
        TransformedEvent<TThis, EventEmitterEventType, any[]>;

/**
 * Event Emitter helper class the supports emitting typed events
 */
export class TypedEventEmitter<TEvent>
    extends EventEmitter
    implements IEventProvider<TEvent & IEvent>
{
    constructor() {
        super();
        this.addListener = super.addListener.bind(this) as TypedEventTransform<this, TEvent>;
        this.on = super.on.bind(this) as TypedEventTransform<this, TEvent>;
        this.once = super.once.bind(this) as TypedEventTransform<this, TEvent>;
        this.prependListener = super.prependListener.bind(this) as TypedEventTransform<
            this,
            TEvent
        >;
        this.prependOnceListener = super.prependOnceListener.bind(this) as TypedEventTransform<
            this,
            TEvent
        >;
        this.removeListener = super.removeListener.bind(this) as TypedEventTransform<this, TEvent>;
        this.off = super.off.bind(this) as TypedEventTransform<this, TEvent>;
    }
    readonly addListener: TypedEventTransform<this, TEvent>;
    readonly on: TypedEventTransform<this, TEvent>;
    readonly once: TypedEventTransform<this, TEvent>;
    readonly prependListener: TypedEventTransform<this, TEvent>;
    readonly prependOnceListener: TypedEventTransform<this, TEvent>;
    readonly removeListener: TypedEventTransform<this, TEvent>;
    readonly off: TypedEventTransform<this, TEvent>;
}

export interface IEvents<TSig extends Record<string, any[]>> {
    <TEvent extends keyof TSig>(event: TEvent, listener: (...args: TSig[TEvent]) => void);
}

// Dropped extending TypedEventEmitter because I don't know how to incorporate the TypedEventTransform stuff
class TypedEventEmitter2<TSignatures extends Record<string | number, any[]>> extends EventEmitter {
    emit<TEvent extends keyof TSignatures>(
        event: TEvent,
        ...args: TSignatures[TEvent]
    ) {
        // Would want to incorporate this class directly in TypedEventEmitter rather than subclassing and calling super.emit

        // This is trouble, I think. Looks like Node and the Polyfill only both handle strings. So numbers and symbols will result in ???
        // We can't avoid numbers (because if you have a string index signature you also get a number index signature, by some quirk).
        const eventForBase = event as EventEmitterEventType;
        return super.emit(eventForBase, ...args);
    }

    on<TEvent extends keyof TSignatures>(
        event: TEvent,
        listener: (...args: TSignatures[TEvent]) => void,
    ) {
        // Would want to incorporate this class directly in TypedEventEmitter rather than subclassing and calling super.on

        // This is trouble, I think. Looks like Node and the Polyfill only both handle strings. So numbers and symbols will result in ???
        // We can't avoid numbers (because if you have a string index signature you also get a number index signature, by some quirk).
        const eventForBase = event as EventEmitterEventType;
        const listenerForBase = listener as Listener; // We know emit will only be called with the right args. So while we have to cast, it will be ok in the end.
        return super.on(eventForBase, listenerForBase);
    }
}

export interface ISampleEventSignatures extends Record<string | number | symbol, any[]> {
    foo: [x: number, y: string];
    bar: [];
    baz: [options: { a: string; b: boolean; }];
    45: [number];
    [Symbol.hasInstance]: [number, string];
// These are blocked because of the any[] in base type
//    notAnArray: boolean;
//    999: boolean;
//    [Symbol.iterator]: number;
// This is allowed because the base type doesn't speak to types of symbol key'd properties. It could be used, but may crash if underlying EventEmitter doesn't support Symbol event names
}
const sample = new TypedEventEmitter2<ISampleEventSignatures>();

// These are strongly typed (assuming you spell the type parameter correctly)
sample.emit("foo", 3, "asdf");
sample.emit("bar");
sample.emit("baz", { a: "hello", b: true });

// Now this is supported. But we lose suggestions on event names (but if you get the name right you still get the specific signature in intellisense)
sample.emit("unspecified", 123);

sample.on("foo", (x: number, y: string) => {});

sample.emit(4, 4);
sample.emit(Symbol.iterator, 123);

