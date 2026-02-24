/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddProjectRequest } from '../models/AddProjectRequest';
import type { AgentResponse } from '../models/AgentResponse';
import type { CommitInfo } from '../models/CommitInfo';
import type { DiffResponse } from '../models/DiffResponse';
import type { ProjectInfo } from '../models/ProjectInfo';
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
     * List all known projects
     * @returns ProjectInfo OK
     * @throws ApiError
     */
    public listProjects(): CancelablePromise<Array<ProjectInfo>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects',
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Add a new project by folder path
     * @param requestBody
     * @returns ProjectInfo Created
     * @throws ApiError
     */
    public addProject(
        requestBody: AddProjectRequest,
    ): CancelablePromise<ProjectInfo> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List all Hydra agents (heads)
     * @param projectId Project ID to scope the agent list (defaults to server CWD project)
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public listAgents(
        projectId?: string,
    ): CancelablePromise<Array<AgentResponse>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agents',
            query: {
                'project_id': projectId,
            },
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Spawn a new Hydra agent
     * @param requestBody
     * @param projectId Project ID to spawn the agent in (defaults to server CWD project)
     * @returns AgentResponse Created
     * @throws ApiError
     */
    public spawnAgent(
        requestBody: SpawnAgentRequest,
        projectId?: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agents',
            query: {
                'project_id': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List commits on an agent's branch (between base branch and agent branch)
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns CommitInfo OK
     * @throws ApiError
     */
    public getAgentCommits(
        id: string,
        projectId?: string,
    ): CancelablePromise<Array<CommitInfo>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent/{id}/commits',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the diff for an agent's branch
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @param baseRef Base commit SHA or ref. Defaults to the agent's base branch.
     * @param headRef Head commit SHA or ref. Defaults to the agent's branch.
     * @param ignoreWhitespace Ignore whitespace changes in the diff
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getAgentDiff(
        id: string,
        projectId?: string,
        baseRef?: string,
        headRef?: string,
        ignoreWhitespace?: boolean,
    ): CancelablePromise<DiffResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent/{id}/diff',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
                'base_ref': baseRef,
                'head_ref': headRef,
                'ignore_whitespace': ignoreWhitespace,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get a specific Hydra agent by ID
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public getAgent(
        id: string,
        projectId?: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent/{id}',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Kill a Hydra agent by ID
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns void
     * @throws ApiError
     */
    public killAgent(
        id: string,
        projectId?: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/agent/{id}',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
}
