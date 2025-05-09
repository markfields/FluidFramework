/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	IStorageNameRetriever,
	IRevokedTokenChecker,
	IReadinessCheck,
} from "@fluidframework/server-services-core";
import { IRedisClientConnectionManager } from "@fluidframework/server-services-utils";
import { ISimplifiedCustomDataRetriever } from "./services";

export interface IHistorianResourcesCustomizations {
	storageNameRetriever?: IStorageNameRetriever;
	revokedTokenChecker?: IRevokedTokenChecker;
	redisClientConnectionManager?: IRedisClientConnectionManager;
	redisClientConnectionManagerForThrottling?: IRedisClientConnectionManager;
	redisClientConnectionManagerForInvalidTokenCache?: IRedisClientConnectionManager;
	readinessCheck?: IReadinessCheck;
	simplifiedCustomDataRetriever?: ISimplifiedCustomDataRetriever;
}
