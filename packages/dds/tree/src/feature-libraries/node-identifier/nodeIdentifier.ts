/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { SessionSpaceCompressedId, StableId } from "@fluidframework/id-compressor";

import type { TreeNodeSchemaIdentifier } from "../../core/index.js";
import { type Brand, type Opaque, brand } from "../../util/index.js";

/**
 * An identifier which uniquely identifies a node in the tree within this session.
 * @remarks {@link LocalNodeIdentifier}s must not be serialized and stored as data without first being converted into a {@link StableNodeIdentifier}.
 * They are local to the current session and equivalent nodes in another session will not necessarily have the same {@link LocalNodeIdentifier}.
 * However, they are otherwise preferential to use over {@link StableNodeIdentifier}s as they are much smaller.
 * For example, they are more efficient than {@link StableNodeIdentifier}s when used as keys in a map.
 * {@link LocalNodeIdentifier}s may be compared or equated via {@link compareLocalNodeIdentifiers}.
 */
export interface LocalNodeIdentifier
	extends Opaque<Brand<SessionSpaceCompressedId, "Local Node Identifier">> {}

/**
 * A UUID which identifies a node in the tree.
 * This key is universally unique and stable forever; therefore it is safe to persist as data in a SharedTree or other DDS/database.
 * When not persisted or serialized, it is preferable to use a {@link LocalNodeIdentifier} instead for better performance.
 */
export type StableNodeIdentifier = Brand<StableId, "Stable Node Identifier">;

/**
 * Compares two {@link LocalNodeIdentifier}s.
 * All {@link LocalNodeIdentifier}s retrieved from a single SharedTree client can be totally ordered using this comparator.
 * @param a - the first identifier to compare
 * @param b - the second identifier to compare
 * @returns `0` if `a` and `b` are the same identifier, otherwise `-1` if `a` is ordered before `b` or `1` if `a` is ordered after `b`.
 */
export function compareLocalNodeIdentifiers(
	a: LocalNodeIdentifier,
	b: LocalNodeIdentifier,
): -1 | 0 | 1 {
	return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * The TreeNodeSchemaIdentifier for node identifiers.
 * @privateRemarks TODO: Come up with a unified and collision-resistant naming schema for types defined by the system.
 * For now, we'll use `__` to reduce the change of collision, since this is what other internal properties use in Fluid.
 */
export const nodeKeyTreeIdentifier: TreeNodeSchemaIdentifier = brand(
	"com.fluidframework.nodeIdentifier.NodeIdentifier",
);
