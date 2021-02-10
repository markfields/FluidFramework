/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/common-utils";
import {
    ContainerErrorType,
    IGenericError,
    ICriticalContainerError,
    IErrorBase,
} from "@fluidframework/container-definitions";
import { LoggingError } from "@fluidframework/telemetry-utils";
import { ITelemetryProperties } from "@fluidframework/common-definitions";

function messageFromError(error: any) {
    if (typeof error?.message === "string") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return error.message;
    }
    return `${error}`;
}

/** Type guard for IErrorBase */
export const IsIErrorBase = (error: any): error is IErrorBase =>
    ("errorType" in error) && ("message" in error);

/**
 * Generic error
 */
export class GenericError extends LoggingError implements IGenericError {
    readonly errorType = ContainerErrorType.genericError;

    /**
     * Create a wrapper for an error of unknown origin
     * @param message - message from innerError (see function messageFromError)
     * @param props - Properties pulled off the error that are safe to log
     * @param innerError - intact error object we are wrapping. Should not be logged as-is
     */
    constructor(
        message: string,
        props?: ITelemetryProperties,
        readonly innerError?: any,
    ) {
        super(message, props);
    }
}

//* implements IDataCorruptionError
export class DataCorruptionError extends LoggingError implements IErrorBase {
    readonly errorType = ContainerErrorType.dataCorruptionError;
    readonly canRetry = false;

    constructor(
        message: string,
        props?: ITelemetryProperties,
    ) {
        super(message, props);
    }
}

/**
 * Convert the error into one of the error types.
 * @param error - Error to be converted.
 */
export function CreateContainerError(error: any): ICriticalContainerError & LoggingError {
    assert(error !== undefined);

    if (typeof error === "object" && error !== null) {
        if (IsIErrorBase(error) && error instanceof LoggingError) {
            return error;
        }

        if (IsIErrorBase(error)) {
            return new LoggingError(
                error.message,
                { errorType: error.errorType, stack: (error as any).stack },
            ) as IErrorBase & LoggingError;
        }
        // Note - Only the message and stack will be logged, the error itself (as GenericError.innerError) will not be
        return new GenericError(
            messageFromError(error),
            { stack: error.stack },
            error,
        );
    } else {
        return new GenericError(messageFromError(error));
    }
}
