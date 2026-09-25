# What do the garbage collection end-to-end tests cover?

These specs check garbage collection (GC) across changes to references, summaries, and service storage.

## `gcAttachmentBlobs.spec.ts`

Checks reference tracking and deletion of attachment blobs uploaded before attachment, after attachment, or during a disconnection, including deduplicated uploads.

## `gcContainerRuntimeCompat.spec.ts`

Checks that a container runtime can read unreferenced timestamps from summaries written by another runtime version.

## `gcDataVirtualization.spec.ts`

Checks that virtualized data stores retain their GC state when their snapshots are not downloaded.

## `gcDatastoreAliased.spec.ts`

Checks that assigning an alias keeps a data store referenced even when no handle to it remains in a shared object.

## `gcDatastoreDuplicateRoutes.spec.ts`

Checks that changes to shared objects do not introduce duplicate routes into a data store's GC state.

## `gcDeleteObjectsInTestMode.spec.ts`

Checks how test-mode GC marks data stores and attachment blobs as referenced or unreferenced and deletes unreferenced content.

## `gcInactiveNodes.spec.ts`

Checks inactive-node telemetry and how reviving inactive data stores or attachment blobs changes their state.

## `gcIncrementalSummaries.spec.ts`

Checks that incremental summaries reuse handles for unchanged data stores, rewrite stores whose content or reference state changed, and recover from failed uploads.

## `gcReferenceUpdatesInSummary.spec.ts`

Checks that handle changes in shared objects, including undo and redo, update data-store reference state in the next summary.

## `gcStats.spec.ts`

Checks GC statistics as nodes become unreferenced, sweep-ready, deleted, or referenced again.

## `gcSummaryLateAck.spec.ts`

Checks that a late acknowledgment for an older summary does not cause a later summary to reuse stale GC data after a failed upload.

The local-service test temporarily intercepts the raw-deltas producer for its document and holds the service-generated acknowledgment before the orderer sequences it.
A real reference-change operation can then sequence while the summarizer's acknowledgment wait expires, and the next summary generates different GC data but fails during upload.
After releasing the original acknowledgment, the test checks that a subsequent summary writes the new GC data and reads the accepted state back from service storage.
The test restores the producer method in `finally` so that the timing injection does not affect later tests.

## `gcSweepAttachmentBlobs.spec.ts`

Checks that sweeping attachment blobs prevents their use and removes them from summaries, including across deduplication and failed summaries.

## `gcSweepDataStores.spec.ts`

Checks that sweeping data stores prevents access to deleted stores and records their deletion in summaries, including retry and trailing-operation cases.

## `gcSweepUnreferencePhases.spec.ts`

Checks that unreferenced objects move through the unreferenced, tombstoned, and deleted phases in order.

## `gcTombstoneAttachmentBlobs.spec.ts`

Checks access to tombstoned attachment blobs in attached, detached, and disconnected containers, including when uploads are deduplicated.

## `gcTombstoneDataStores.spec.ts`

Checks restrictions on loading or changing tombstoned data stores and how summaries record their tombstone state.

## `gcTrailingOps.spec.ts`

Checks that reference changes sequenced after a summary are applied before later GC runs and do not cause live data stores to be deleted.

## `gcTreeSummaryHandles.spec.ts`

Checks when a GC summary can reuse a tree handle and when reference changes or failed uploads require new GC data.

## `gcUnknownHandles.spec.ts`

Checks that handles to unknown object paths do not create unexpected GC nodes or fail collection.

## `gcUnreferencedFlagInSnapshot.spec.ts`

Checks that a data store's unreferenced flag remains correct when an uploaded summary is downloaded as a snapshot.

## `gcUnreferencedTimestamp.spec.ts`

Checks how summaries add, preserve, or remove unreferenced timestamps when references to data stores and attachment blobs change.

## `gcVersionUpdate.spec.ts`

Checks how loading a summary written with a different GC version resets GC state or disables GC.
