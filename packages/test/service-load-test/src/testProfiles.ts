/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

 /**
  * This is the schema of the "profiles" object in testConfig.json
  */
export interface ConfigTestProfiles {
    fullStress: LoadTestProfile,
    miniStress: LoadTestProfile,
    smoke: SmokeTestProfile,
}

export type AnyTestProfile =
    | LoadTestProfile
    | SmokeTestProfile;

export interface LoadTestProfile {
    type: "stress",
    opRatePerMin: number,
    progressIntervalMs: number,
    numClients: number,
    totalSendCount: number,
    readWriteCycleMs: number,
}

export interface SmokeTestProfile {
    type: "smoke",
    numClients: number,
}
