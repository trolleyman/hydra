/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentResponse } from '../models/AgentResponse';
import type { SpawnAgentRequest } from '../models/SpawnAgentRequest';
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
    /**
     * Spawn a new Hydra agent
     * @param requestBody
     * @returns AgentResponse Created
     * @throws ApiError
     */
    public spawnAgent(
        requestBody: SpawnAgentRequest,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agents',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get a specific Hydra agent by ID
     * @param id
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public getAgent(
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent/{id}',
            path: {
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
}
