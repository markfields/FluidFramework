/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IChannelAttributes, IComponentRuntime, ISharedObjectServices } from "@microsoft/fluid-runtime-definitions";
import { ConsensusRegisterCollection } from "./consensusRegisterCollection";
import { IConsensusRegisterCollection, IConsensusRegisterCollectionFactory } from "./interfaces";
import { pkgVersion } from "./packageVersion";

/**
 * The factory that defines the consensus queue
 */
export class ConsensusRegisterCollectionFactory<T> implements IConsensusRegisterCollectionFactory<T> {
    public static Type = "https://graph.microsoft.com/types/consensus-register-collection";

    public static readonly Attributes: IChannelAttributes = {
        type: ConsensusRegisterCollectionFactory.Type,
        snapshotFormatVersion: "0.1",
        packageVersion: pkgVersion,
    };

    public get type() {
        return ConsensusRegisterCollectionFactory.Type;
    }

    public get attributes() {
        return ConsensusRegisterCollectionFactory.Attributes;
    }

    public async load(
        runtime: IComponentRuntime,
        id: string,
        services: ISharedObjectServices,
        branchId: string,
        attributes: IChannelAttributes): Promise<IConsensusRegisterCollection<T>> {
        const collection = new ConsensusRegisterCollection<T>(id, runtime, attributes);
        await collection.load(branchId, services);
        return collection;
    }

    public create(document: IComponentRuntime, id: string): IConsensusRegisterCollection<T> {
        const collection =
            new ConsensusRegisterCollection<T>(id, document, ConsensusRegisterCollectionFactory.Attributes);
        collection.initializeLocal();
        return collection;
    }
}
