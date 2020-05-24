/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as assert from "assert";
import { EventEmitter } from "events";
import { PromiseCache, PromiseCacheOptions } from "@microsoft/fluid-common-utils";
import { ISocketStorageDiscovery, IOdspResolvedUrl } from "./contracts";

export interface ICacheLock {
    key: string;
    lockId: number;
    release: () => void;
}

//* copied from PromiseCache.ts to prove the concept (belongs somewhere else anyway)
export interface IConcurrentCache<TKey, TValue, TExpiry> {
    has(key: TKey): Promise<boolean>;

    get(key: TKey): Promise<TValue | undefined>;

    remove(key: TKey): Promise<boolean>;

    addOrGet(
        key: TKey,
        asyncFn: () => Promise<TValue>,
        expiry?: TExpiry,
    ): Promise<TValue>;

    add(
        key: TKey,
        asyncFn: () => Promise<TValue>,
        expiry?: TExpiry,
    ): Promise<boolean>;

    //* Maybe these too for convenience:
    //* addValueOrGet
    //* addValue
}

//* copied from PromiseCache.ts to prove the concept
export class PromiseCache2<TKey, TResult, TExpiry = never> implements IConcurrentCache<TKey, TResult, TExpiry>{
    private readonly cache = new Map<TKey, Promise<TResult>>();

    private readonly removeOnError: (error: any) => boolean;

    /**
     * Create the PromiseCache with the given options, with the following defaults:
     *
     * expiry: indefinite, removeOnError: true for all errors
     */
    constructor({
        expiry = { policy: "indefinite" },
        removeOnError = () => true,
    }: PromiseCacheOptions = {}) {
        this.removeOnError = removeOnError;
    }

    /**
     * Check if there's anything cached at the given key
     */
    public async has(key: TKey) {
        return this.cache.has(key);
    }

    /**
     * Get the Promise for the given key, or undefined if it's not found.
     * Extend expiry if applicable.
     */
    public async get(key: TKey): Promise<TResult | undefined> {
        return this.cache.get(key);
    }

    /**
     * Remove the Promise for the given key, returning true if it was found and removed
     */
    public async remove(key: TKey) {
        return this.cache.delete(key);
    }

    /**
     * Try to add the result of the given asyncFn, without overwriting an existing cache entry at that key.
     * Returns a Promise for the added or existing async work being done at that key.
     * @param key - key name where to store the async work
     * @param asyncFn - the async work to do and store, if not already in progress under the given key
     */
    public async addOrGet(
        key: TKey,
        asyncFn: () => Promise<TResult>,
        expiry?: TExpiry,
    ): Promise<TResult> {
        // NOTE: Do not await the Promise returned by asyncFn!
        // Let the caller do so once we return or after a subsequent call to get

        if (await this.has(key)) {
            return (await this.get(key))!;
        }

        // Wrap in an async lambda in case asyncFn disabled @typescript-eslint/promise-function-async
        const safeAsyncFn = async () => asyncFn();

        // Start the async work and put the Promise in the cache
        const promise = safeAsyncFn();
        this.cache.set(key, promise);

        // If asyncFn throws, we may remove the Promise from the cache
        promise.catch((error) => {
            if (this.removeOnError(error)) {
                //* floating promise?
                this.remove(key);
            }
        });

        return promise;
    }

    /**
     * Try to add the result of the given asyncFn, without overwriting an existing cache entry at that key.
     * Returns false if the cache already contained an entry at that key, and true otherwise.
     * @param key - key name where to store the async work
     * @param asyncFn - the async work to do and store, if not already in progress under the given key
     */
    public async add(
        key: TKey,
        asyncFn: () => Promise<TResult>,
        expiry?: TExpiry,
    ): Promise<boolean> {
        const alreadyPresent = await this.has(key);

        // We are blindly adding the Promise to the cache here, which introduces a Promise in this scope.
        // Swallow Promise rejections here, since whoever gets this out of the cache to use it will await/catch.
        this.addOrGet(key, asyncFn)
            .catch(() => {});

        return !alreadyPresent;
    }
}

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
 * A cache for data persisted between sessions.  Only serializable content should be put here!
 * This interface may be implemented and provided by the Host, and in order to allow a host
 * to include asynchronous operations in its implementation, each function returns Promise.
 */
export interface IPersistedCache<TExpiry> extends IConcurrentCache<string, any, TExpiry> {
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

        // We are blindly adding the Promise to the cache here, which introduces a Promise in this scope.
        // Swallow Promise rejections here, since whoever gets this out of the cache to use it will await/catch.
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
        public readonly persistedCache3: IPersistedCache<number> = new PromiseCache2<string, number, number>(),
    ) {}
}
