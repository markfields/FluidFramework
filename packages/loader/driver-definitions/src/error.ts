/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

// tslint:disable: no-unsafe-any
enum ErrorType {
    generalError,
    connectionError,
    throttlingError,
    serviceError,
    summarizingError,
    writeError,
    fatalError,
    actuallyX,
    actuallyY,
}

export enum ConnectionErrorType {
    default,
    accessDenied,
    notFound,
}

namespace MetaType2 {
    export const subb = {
        generalError: ErrorType.generalError,
        throttlingError: ErrorType.throttlingError,
    };

    // export class Subb {
    //     export static const generalError: ErrorType.generalError;
    //     export static const throttlingError: ErrorType.throttlingError;
    // }

    // const actually = {
    //     x: ErrorType.actuallyX,
    //     y: ErrorType.actuallyY,
    // };
}

export const MetaType = {
    sub: {
        generalError: ErrorType.generalError,
        throttlingError: ErrorType.throttlingError,
    },
    actually: {
        x: ErrorType.actuallyX,
        y: ErrorType.actuallyY,
    },
};

const foo = MetaType.sub.throttlingError;
alert(foo);

export type IError = IGeneralError | IThrottlingError | IConnectionError |
IServiceError | ISummarizingError | IWriteError | IFatalError;

export interface IGeneralError {
    readonly errorType: ErrorType.generalError;
    error: any;
    critical?: boolean;
}

export interface IThrottlingError {
    readonly errorType: MetaType.sub.throttlingError;
    readonly message: string;
    readonly retryAfterSeconds: number;
    critical?: boolean;
}

export interface IServiceError {
    readonly errorType: ErrorType.serviceError;
    critical?: boolean;
}

export interface ISummarizingError {
    readonly errorType: ErrorType.summarizingError;
    critical?: boolean;
}

export interface IWriteError {
    readonly errorType: ErrorType.writeError;
    readonly critical: boolean;
}

export interface IFatalError {
    readonly errorType: ErrorType.fatalError;
    readonly critical: boolean;
}

export enum ConnectionErrorType {
    accessDenied,
    notFound,
}

export type IConnectionError = IConnectionAccessDeniedError | IConnectionNotFoundError | IGeneralConnectionError;

export interface IConnectionAccessDeniedError extends IGeneralConnectionError {
    readonly connectionError: ConnectionErrorType.accessDenied;
}

export interface IConnectionNotFoundError extends IGeneralConnectionError {
    readonly connectionError: ConnectionErrorType.notFound;
}

export interface IGeneralConnectionError {
    readonly errorType: ErrorType.connectionError;
    readonly connectionError?: ConnectionErrorType
    readonly message: string;
    readonly canRetry?: boolean;
    readonly statusCode?: number;
    readonly online: string;
    critical?: boolean;
}
