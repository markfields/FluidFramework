/* eslint-disable max-len */
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDisposable } from "@fluidframework/common-definitions";

/**
 * Three supported expiry policies:
 * - indefinite: entries don't expire and must be explicitly removed
 * - absolute: entries expire after the given duration in MS, even if accessed multiple times in the mean time
 * - sliding: entries expire after the given duration in MS of inactivity (i.e. get resets the clock)
 * - slidingOnWrite: //* TODO - Is this a good policy? This is what OdspCache does. Maybe support it
 */
export type PromiseCacheExpiry =
    | {
          policy: "indefinite";
      }
    | {
          policy: "absolute" | "sliding";
          durationMs: number;
      };

/**
 * Options for configuring the {@link PromiseCache}
 */
export interface PromiseCacheOptions {
    /** Common expiration policy for all items added to this cache */
    expiry?: PromiseCacheExpiry;
    /** If the stored Promise is rejected with a particular error, should the given key be removed? */
    removeOnError?: (e: any) => boolean;
}

/**
 * Handles garbage collection of expiring cache entries.
 * Not exported.
 */
class GarbageCollector<TKey> {
    private readonly gcTimeouts = new Map<TKey, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly expiry: PromiseCacheExpiry,
        private readonly cleanup: (key: TKey) => void,
    ) {}

    /**
     * Schedule GC for the given key, as applicable
     */
    public schedule(key: TKey): void {
        if (this.expiry.policy !== "indefinite") {
            this.gcTimeouts.set(
                key,
                setTimeout(() => {
                    this.cleanup(key);
                    this.cancel(key);
                }, this.expiry.durationMs),
            );
        }
    }

    /**
     * Cancel any pending GC for the given key
     */
    public cancel(key: TKey): void {
        const timeout = this.gcTimeouts.get(key);
        if (timeout !== undefined) {
            clearTimeout(timeout);
            this.gcTimeouts.delete(key);
        }
    }

    /**
     * Update any pending GC for the given key, as applicable
     */
    public update(key: TKey): void {
        // Cancel/reschedule new GC if the policy is sliding
        if (this.expiry.policy === "sliding") {
            this.cancel(key);
            this.schedule(key);
        }
    }
}
class MapWithExpiration<TKey, TValue> extends Map<TKey, TValue> implements IDisposable {
    public disposed: boolean = false;
    private readonly expirationTimeouts = new Map<TKey, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly expiration: PromiseCacheExpiry,
    ) {
        super();
    }
    private scheduleExpiration(key: TKey, expiryMs: number) {
        this.expirationTimeouts.set(
            key,
            setTimeout(
                () => { this.delete(key); },
                expiryMs,
            ),
        );
    }

    private cancelExpiration(key: TKey) {
        const timeout = this.expirationTimeouts.get(key);
        if (timeout !== undefined) {
            clearTimeout(timeout);
            this.expirationTimeouts.delete(key);
        }
    }

    resetExpiration(key: TKey) {
        this.cancelExpiration(key);
        if (this.expiration.policy !== "indefinite") {
            this.scheduleExpiration(key, this.expiration.durationMs);
        }
    }

    get(key: TKey): TValue | undefined {
        if (this.expiration.policy === "sliding") {
            this.resetExpiration(key);
        }
        return super.get(key);
    }

    set(key: TKey, value: TValue): this {
        this.resetExpiration(key);
        return super.set(key, value);
    }

    delete(key: TKey): boolean {
        this.cancelExpiration(key);
        return super.delete(key);
    }

    dispose(_error?: Error): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        Array.from(this).forEach(([key]) => this.cancelExpiration(key));
    }
}

type AwaitedReturnType<T extends (...args: any[]) => any> =
    ReturnType<T> extends Promise<infer U>
        ? U
        : never;

/**
 * A wrapper for an async operation that builds in safe caching of the result of the operation
 * to avoid duplicating the async work
 */
class AsyncOperationWithCaching<TOperation extends (...args: any[]) => Promise<any>, TKey> {
    /**
     * Wrap the given async operation to prepare for caching
     * @param operation - The async function to run via getResult
     * @param computeKey - How to compute the cache key for a given execution of getResult
     * @param cache - The cache to store the Promises returned by the async function
     */
    constructor(
        private readonly operation: (...params: Parameters<TOperation>) => Promise<AwaitedReturnType<TOperation>>,
        private readonly computeKey: (...params: Parameters<TOperation>) => TKey,
        private readonly cache: Map<TKey, Promise<AwaitedReturnType<TOperation>>> = new Map(),
    ) {

    }

    // OR: getResult(...params: Parameters<TOperation>): ReturnType<TOperation> AND CAST return VALUE
    async getResult(...params: Parameters<TOperation>): Promise<AwaitedReturnType<TOperation>> {
        // NOTE: Do not await the Promise returned by asyncFn!
        // Let the caller do so once we return or after a subsequent call to get
        const key = this.computeKey(...params);
        let promise = this.cache.get(key);
        if (promise === undefined) {
            // Wrap in an async lambda to ensure errors thrown from this.operation reject the cached promise
            // (in case the operation disabled @typescript-eslint/promise-function-async)
            const safeAsyncFn = async () => this.operation(...params);

            // Start the async work and put the Promise in the cache
            promise = safeAsyncFn();
            this.cache.set(key, promise);

            // If the operation throws, we may remove the Promise from the cache
            promise.catch((error) => {
                // *if (this.removeOnError(error)) {
                    this.removeCacheEntry(key);
                // }
            });
        }

        return promise;
    }

    removeCacheEntry(key: TKey) {
        this.cache.delete(key);
    }
}

async function test() {
    const operation = async (p1: string, p2: number) => { return `${p1}-${p2}`; };
    const ins: Parameters<typeof operation> = ["p1", 2];
    const outs: ReturnType<typeof operation> & Promise<any> = Promise.resolve("answer");
    const cache = new MapWithExpiration<string, Promise<string>>({ policy: "sliding", durationMs: 1000});

    //* Kind of awkward to prime the cache
    cache.set("hello", Promise.resolve("world"));
    const opWithCache = new AsyncOperationWithCaching<typeof operation, string>(
        operation,
        (p11, p2) => p11,
        cache);
    const resultP = opWithCache.getResult("hello", 1);

    //* Thinking about whether the promise resolving should reset expiration.
    //* Could do this automatically in PromiseCache but not in AsyncOperationWithCaching
    return resultP.then(() => cache.resetExpiration("hello"));
}

/**
 * A specialized cache for async work, allowing you to safely cache the promised result of some async work
 * without fear of running it multiple times or losing track of errors.
 */
export class PromiseCache<TKey, TResult> {
    private readonly cache = new Map<TKey, Promise<TResult>>();
    private readonly gc: GarbageCollector<TKey>;

    private readonly removeOnError: (error: any) => boolean;

    /**
     * Create the PromiseCache with the given options, with the following defaults:
     *
     * expiry: indefinite, removeOnError: true for all errors
     */
    constructor({
        expiry = { policy: "indefinite" },
        removeOnError = (): boolean => true,
    }: PromiseCacheOptions = {}) {
        this.removeOnError = removeOnError;
        this.gc = new GarbageCollector<TKey>(expiry, (key) => this.remove(key));
    }

    /**
     * Check if there's anything cached at the given key
     */
    public has(key: TKey): boolean {
        return this.cache.has(key);
    }

    /**
     * Get the Promise for the given key, or undefined if it's not found.
     * Extend expiry if applicable.
     */
    public get(key: TKey): Promise<TResult> | undefined {
        if (this.has(key)) {
            this.gc.update(key);
        }
        return this.cache.get(key);
    }

    /**
     * Remove the Promise for the given key, returning true if it was found and removed
     */
    public remove(key: TKey): boolean {
        this.gc.cancel(key);
        return this.cache.delete(key);
    }

    /**
     * Try to add the result of the given asyncFn, without overwriting an existing cache entry at that key.
     * Returns a Promise for the added or existing async work being done at that key.
     * @param key - key name where to store the async work
     * @param asyncFn - the async work to do and store, if not already in progress under the given key
     */
    public async addOrGet(key: TKey, asyncFn: () => Promise<TResult>): Promise<TResult> {
        // NOTE: Do not await the Promise returned by asyncFn!
        // Let the caller do so once we return or after a subsequent call to get
        let promise = this.get(key);
        if (promise === undefined) {
            // Wrap in an async lambda in case asyncFn disabled @typescript-eslint/promise-function-async
            const safeAsyncFn = async (): Promise<TResult> => asyncFn();

            // Start the async work and put the Promise in the cache
            promise = safeAsyncFn();
            this.cache.set(key, promise);

            // If asyncFn throws, we may remove the Promise from the cache
            promise
            .then(() => {
                //* Is this a good idea?  Basically what if the asyncFn takes most of the expiration time? Anybody care?
                this.gc.update(key);
            })
            .catch((error) => {
                if (this.removeOnError(error)) {
                    this.remove(key);
                }
            });

            this.gc.schedule(key);
        }

        return promise;
    }

    /**
     * Try to add the result of the given asyncFn, without overwriting an existing cache entry at that key.
     * Returns false if the cache already contained an entry at that key, and true otherwise.
     * @param key - key name where to store the async work
     * @param asyncFn - the async work to do and store, if not already in progress under the given key
     */
    public add(key: TKey, asyncFn: () => Promise<TResult>): boolean {
        const alreadyPresent = this.has(key);

        // We are blindly adding the Promise to the cache here, which introduces a Promise in this scope.
        // Swallow Promise rejections here, since whoever gets this out of the cache to use it will await/catch.
        this.addOrGet(key, asyncFn).catch(() => {});

        return !alreadyPresent;
    }

    /**
     * Try to add the given value, without overwriting an existing cache entry at that key.
     * Returns a Promise for the added or existing async work being done at that key.
     * @param key - key name where to store the async work
     * @param value - value to store
     */
    public async addValueOrGet(key: TKey, value: TResult): Promise<TResult> {
        return this.addOrGet(key, async () => value);
    }

    /**
     * Try to add the given value, without overwriting an existing cache entry at that key.
     * Returns false if the cache already contained an entry at that key, and true otherwise.
     * @param key - key name where to store the value
     * @param value - value to store
     */
    public addValue(key: TKey, value: TResult): boolean {
        return this.add(key, async () => value);
    }
}
