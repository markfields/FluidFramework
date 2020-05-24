/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as assert from "assert";
import { EventEmitter } from "events";
import { PromiseCache } from "@microsoft/fluid-common-utils";
import { ISocketStorageDiscovery, IOdspResolvedUrl } from "./contracts";

export interface ICacheLock {
    key: string;
    lockId: number;
    release: () => void;
}

/**
 * General purpose interface for working with a cache to protect against race conditions
 */
//* This belongs somewhere else. Similar shape to PromiseCache but all functions are async
export interface IConcurrentCache<TKey, TValue, TExpiry> {
    has(key: TKey): Promise<boolean>;

    get(key: TKey): Promise<TValue | undefined>;

    remove(key: TKey): Promise<boolean>;

    addOrGet(
        key: TKey,
        asyncFn: () => Promise<TValue>,
        expiry?: TExpiry,
    ): Promise<TValue>;

    //* Question: Would this be expected to await asyncFn, or not? i.e. if asyncFn rejects should this?
    add(
        key: TKey,
        asyncFn: () => Promise<TValue>,
        expiry?: TExpiry,
    ): Promise<boolean>;

    //* Maybe these too for convenience:
    //* addValueOrGet
    //* addValue
}

/**
 * A cache for data persisted between sessions.  Only serializable content should be put here!
 * This interface may be implemented and provided by the Host, and in order to allow a host
 * to include asynchronous operations in its implementation, each function returns Promise.
 * 
 * TExpiry is the way expiration should be specified on each add/addOrGet call.
 * To remove support for callers specifying expiration, use as IPersistedCache<never>.
 */
export interface IPersistedCache<TExpiry> extends IConcurrentCache<string, any, TExpiry> {
}

/**
 * A concise local implementation of IPersistedCache using PromiseCache
 */
//* Doesn't implement GC (need to update PromiseCache to support per-operation expiry)
export class LocalCache implements IPersistedCache<number> {
    private readonly pc: PromiseCache<string, any> = new PromiseCache();
    async has(key: string): Promise<boolean> {
        return this.pc.has(key);
    }
    async get(key: string): Promise<any> {
        return this.pc.get(key);
    }
    async remove(key: string): Promise<boolean> {
        return this.pc.remove(key);
    }
    async addOrGet(key: string, asyncFn: () => Promise<any>, expiry?: number | undefined): Promise<any> {
        return this.pc.addOrGet(key, asyncFn);
    }
    async add(key: string, asyncFn: () => Promise<any>, expiry?: number | undefined): Promise<boolean> {
        return this.pc.add(key, asyncFn);
    }
}

/**
 * Handles garbage collection of expiring cache entries.
 * Not exported.
 * (Based off of the same class in promiseCache.ts, could be consolidated)
 */
class GarbageCollector<TKey> {
    private readonly gcTimeouts = new Map<TKey, NodeJS.Timeout>();

    constructor(
        private readonly cleanup: (key: TKey) => void,
    ) {}

    /**
     * Schedule GC for the given key, as applicable
     */
    public schedule(key: TKey, durationMs: number) {
        this.gcTimeouts.set(
            key,
            setTimeout(
                () => { this.cleanup(key); this.cancel(key); },
                durationMs,
            ),
        );
    }

    /**
     * Cancel any pending GC for the given key
     */
    public cancel(key: TKey) {
        const timeout = this.gcTimeouts.get(key);
        if (timeout !== undefined) {
            clearTimeout(timeout);
            this.gcTimeouts.delete(key);
        }
    }
}

//* For demo purposes - Or maybe this is the interface we expect hosts to implement, and we keep the Demo class below
interface IAsyncStore {
    get: (key: string) => Promise<any>;
    has: (key: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
    set: (key: string, value: any) => Promise<void>;
}

/**
 * Default local-only implementation of IPersistedCache,
 * used if no persisted cache is provided by the host
 */
export class DemoWithUnderlyingAsyncStore extends EventEmitter implements IPersistedCache<number> {
    private readonly cache: IAsyncStore = null; //* don't bother implementing it
    //* Btw - GC doesn't properly handle async here
    private readonly gc: GarbageCollector<string> = new GarbageCollector<string>((key) => this.cache.delete(key));
    private readonly heldLockIds: Map<string, number> = new Map();
    private nextLockId: number = 0;

    private lockNow(key: string): ICacheLock {
        assert(!this.heldLockIds.has(key));
        const lock: ICacheLock = {
            key,
            lockId: ++this.nextLockId,
            release: async () => {
                this.heldLockIds.delete(key);
                this.emit("lockRelease", key);
            },
        };
        this.heldLockIds.set(key, lock.lockId);
        return lock;
    }

    private async lock(key: string): Promise<ICacheLock> {
        if (!this.heldLockIds.has(key)) {
            return this.lockNow(key);
        }

        return new Promise((resolve, reject) => {
            this.on("lockRelease", (releasedKey) => {
                if (releasedKey === key) {
                    resolve(this.lockNow(key));
                }
            });
            setTimeout(() => reject(new Error("Declaring deadlock after 3 seconds")), 3000);
        });
    }

    async has(key: string): Promise<boolean> {
        return this.cache.has(key);
    }

    async get(key: string): Promise<any> {
        return this.cache.get(key);
    }

    async remove(key: string) {
        const lock = await this.lock(key);
        const deleted = await this.cache.delete(key);
        this.gc.cancel(key);
        lock.release();

        return deleted;
    }

    async addOrGet(key: string, asyncFn: () => Promise<any>, expiry?: number | undefined): Promise<any> {
        let value = await this.cache.get(key);
        if (value === undefined) {
            const lock = await this.lock(key);
            value = await this.cache.get(key) ?? await asyncFn();
            await this.cache.set(key, value);
            if (expiry) {
                this.gc.schedule(key, expiry);
            }
            lock.release();
        }
        return value;
    }

    async add(key: string, asyncFn: () => Promise<any>, expiry?: number | undefined): Promise<boolean> {
        const alreadyPresent = this.has(key);

        // We don't want to await the Promise here, but we've introduced a Promise in this scope,
        // so swallow Promise rejections here, since whoever gets this out of the cache to use it will await/catch.
        this.addOrGet(key, asyncFn, expiry)
            .catch(() => {});

        return !alreadyPresent;
    }
}

export class PromiseCacheWithOneHourSlidingExpiry<T> extends PromiseCache<string, T> {
    constructor(removeOnError?: (e: any) => boolean) {
        super({ expiry: { policy: "sliding", durationMs: 3600000 }, removeOnError });
    }
}

/**
 * Internal cache interface used within driver only
 */
export interface IOdspCache {
    /**
     * Persisted cache - only serializable content is allowed
     */
    readonly persistedCache: IPersistedCache<number>;

    /**
     * Cache of joined/joining session info
     * This cache will use a one hour sliding expiration window.
     */
    readonly sessionJoinCache: PromiseCacheWithOneHourSlidingExpiry<ISocketStorageDiscovery>;

    /**
     * Cache of resolved/resolving file URLs
     */
    readonly fileUrlCache: PromiseCache<string, IOdspResolvedUrl>;
}

export class OdspCache implements IOdspCache {
    public readonly sessionJoinCache = new PromiseCacheWithOneHourSlidingExpiry<ISocketStorageDiscovery>();

    public readonly fileUrlCache = new PromiseCache<string, IOdspResolvedUrl>();

    /**
     * Initialize the OdspCach, with an optional cache to store persisted data in.
     * If an IPersistedCache is not provided, we'll use a local-only cache for this session.
     */
    constructor(
        public readonly persistedCache: IPersistedCache<number> = new LocalCache(),
        public readonly persistedCache2: IPersistedCache<number> = new DemoWithUnderlyingAsyncStore(),
    ) {}
}
