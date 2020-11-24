/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import { IDisposable, ITelemetryBaseLogger, ITelemetryLogger } from "@fluidframework/common-definitions";
import { assert, Deferred, Lazy, PromiseCache } from "@fluidframework/common-utils";
import { ChildLogger } from "@fluidframework/telemetry-utils";
import { FluidDataStoreContext } from "./dataStoreContext";

 export class DataStoreContexts extends EventEmitter implements Iterable<[string,FluidDataStoreContext]>, IDisposable {
    private readonly notBoundContexts = new Set<string>();

    // Attached and loaded context proxies
    private readonly _contexts = new Map<string, FluidDataStoreContext>();
    // List of pending contexts (for the case where a client knows a store will exist and is waiting
    // on its creation). This is a superset of contexts.
    private readonly contextsDeferred = new Map<string, Deferred<FluidDataStoreContext>>();

    private readonly pendingBindPs = new PromiseCache<string, FluidDataStoreContext>();

    //* make private, replacing _contexts
    public readonly allContexts = new Map<string, { context: FluidDataStoreContext, bound: boolean }>();

    private readonly disposeOnce = new Lazy<void>(()=>{
        // close/stop all store contexts
        for (const [fluidDataStoreId, contextD] of this.contextsDeferred) {
            contextD.promise.then((context) => {
                context.dispose();
            }).catch((contextError) => {
                this._logger.sendErrorEvent({
                    eventName: "FluidDataStoreContextDisposeError",
                    fluidDataStoreId,
                },
                contextError);
            });
        }
    });

    private readonly _logger: ITelemetryLogger;

    constructor(baseLogger: ITelemetryBaseLogger) {
        super();
        this._logger = ChildLogger.create(baseLogger);
    }

    [Symbol.iterator](): Iterator<[string, FluidDataStoreContext]> {
        return this._contexts.entries();
    }

    public get disposed() { return this.disposeOnce.evaluated;}
    public readonly dispose = () => this.disposeOnce.value;

    public has(id: string) {
        return this._contexts.has(id);
    }

    public notBoundLength() {
        return Array.from(this.allContexts)
            .filter(([_, cb]) => {
                return !cb.bound;
            })
            .length;
    }

    public async getContextUponBinding(id: string) {
        return this.pendingBindPs.addOrGet(id, this.waitForContextBind(id));
    }

    public notifyOnBind(id: string) {
        const cb = this.allContexts.get(id);
        assert(cb !== undefined && cb.bound !== true);

        this.emit("bind", { id });
        this.allContexts.set(id, { ...cb, bound: true });
    }

    private readonly waitForContextBind = (id: string) => async () => new Promise<FluidDataStoreContext>((res, rej) => {
        this.on("bind", (args) => {
            if (args.id === id) {
                const cb = this.allContexts.get(id);
                if (cb === undefined) {
                    rej(new Error("bind called for missing context"));
                    return;
                }
                this.allContexts.set(id, { ...cb, bound: true });
                res(cb.context);
            }
        });
    });

    private addPendingBind(id: string) {
        this.pendingBindPs.add(id, this.waitForContextBind(id));
    }

    public setupNew(context: FluidDataStoreContext) {
        const id = context.id;
        assert(!this._contexts.has(id), "Creating store with existing ID");
        this.notBoundContexts.add(id);
        const deferred = new Deferred<FluidDataStoreContext>();
        this.contextsDeferred.set(id, deferred);
        this._contexts.set(id, context);

        // Not bound yet
        this.allContexts.set(id, { context, bound: false });
        this.addPendingBind(id);
    }

    public ensureDeferred(id: string): Deferred<FluidDataStoreContext> {
        const deferred = this.contextsDeferred.get(id);
        if (deferred) { return deferred; }
        const newDeferred = new Deferred<FluidDataStoreContext>();
        this.contextsDeferred.set(id, newDeferred);
        return newDeferred;
    }

    public getDeferred(id: string): Deferred<FluidDataStoreContext> {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const deferred = this.contextsDeferred.get(id)!;
        assert(!!deferred);
        return deferred;
    }

    public setNew(id: string, context: FluidDataStoreContext) {
        assert(!!context);
        assert(id === context.id);
        assert(!this._contexts.has(id));
        this._contexts.set(id, context);
        const deferred = this.ensureDeferred(id);
        deferred.resolve(context);

        // Assume it's bound (?)
        this.allContexts.set(id, { context, bound: true });
    }

    public get(id: string): FluidDataStoreContext {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const context = this._contexts.get(id)!;
        assert(!!context);
        return context;
    }

    public tryGet(id: string): FluidDataStoreContext | undefined {
        return this._contexts.get(id);
    }
 }
