/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentResponse } from '../models/AgentResponse';
import type { StatusResponse } from '../models/StatusResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class DefaultService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Health check
     * @returns string OK
     * @throws ApiError
     */
    public checkHealth(): CancelablePromise<string> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/health',
        });
    }
    /**
     * Get system status
     * @returns StatusResponse OK
     * @throws ApiError
     */
    public getStatus(): CancelablePromise<StatusResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/status',
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List all Hydra agents (heads)
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public listAgents(): CancelablePromise<Array<AgentResponse>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agents',
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
}
