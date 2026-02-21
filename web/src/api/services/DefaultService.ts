/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Agent } from '../models/Agent';
import type { AgentType } from '../models/AgentType';
import type { CreateAgentRequest } from '../models/CreateAgentRequest';
import type { CreateProjectRequest } from '../models/CreateProjectRequest';
import type { DirectoryInfo } from '../models/DirectoryInfo';
import type { FileMeta } from '../models/FileMeta';
import type { PickFolderResponse } from '../models/PickFolderResponse';
import type { Project } from '../models/Project';
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
     * List built-in agent types
     * @returns AgentType OK
     * @throws ApiError
     */
    public listAgentTypes(): CancelablePromise<Array<AgentType>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent-types',
        });
    }
    /**
     * Open a native OS folder picker dialog
     * @returns PickFolderResponse OK
     * @throws ApiError
     */
    public pickFolder(): CancelablePromise<PickFolderResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/pick-folder',
            errors: {
                403: `Forbidden - only available on localhost`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List all known projects
     * @returns Project OK
     * @throws ApiError
     */
    public listProjects(): CancelablePromise<Array<Project>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects',
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Create a new project
     * @param requestBody
     * @returns Project Created
     * @throws ApiError
     */
    public createProject(
        requestBody: CreateProjectRequest,
    ): CancelablePromise<Project> {
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
     * Get a single project
     * @param projectId
     * @returns Project OK
     * @throws ApiError
     */
    public getProject(
        projectId: string,
    ): CancelablePromise<Project> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}',
            path: {
                'projectId': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Remove a project (does not delete files)
     * @param projectId
     * @returns void
     * @throws ApiError
     */
    public deleteProject(
        projectId: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{projectId}',
            path: {
                'projectId': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List agents for a project
     * @param projectId
     * @returns Agent OK
     * @throws ApiError
     */
    public listAgents(
        projectId: string,
    ): CancelablePromise<Array<Agent>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/agents',
            path: {
                'projectId': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Create and start an agent
     * @param projectId
     * @param requestBody
     * @returns Agent Created
     * @throws ApiError
     */
    public createAgent(
        projectId: string,
        requestBody: CreateAgentRequest,
    ): CancelablePromise<Agent> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{projectId}/agents',
            path: {
                'projectId': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get agent detail and status
     * @param projectId
     * @param agentId
     * @returns Agent OK
     * @throws ApiError
     */
    public getAgent(
        projectId: string,
        agentId: string,
    ): CancelablePromise<Agent> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/agents/{agentId}',
            path: {
                'projectId': projectId,
                'agentId': agentId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Stop and delete agent and worktree
     * @param projectId
     * @param agentId
     * @returns void
     * @throws ApiError
     */
    public deleteAgent(
        projectId: string,
        agentId: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{projectId}/agents/{agentId}',
            path: {
                'projectId': projectId,
                'agentId': agentId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Merge agent branch and clean up worktree
     * @param projectId
     * @param agentId
     * @returns Agent OK
     * @throws ApiError
     */
    public mergeAgent(
        projectId: string,
        agentId: string,
    ): CancelablePromise<Agent> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{projectId}/agents/{agentId}/merge',
            path: {
                'projectId': projectId,
                'agentId': agentId,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Stream agent logs via SSE
     * @param projectId
     * @param agentId
     * @returns string SSE stream of log lines
     * @throws ApiError
     */
    public streamAgentLogs(
        projectId: string,
        agentId: string,
    ): CancelablePromise<string> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/agents/{agentId}/logs',
            path: {
                'projectId': projectId,
                'agentId': agentId,
            },
            errors: {
                404: `Not Found`,
            },
        });
    }
    /**
     * Get info about a directory in the repository
     * @param projectId
     * @param path
     * @param branch
     * @returns DirectoryInfo OK
     * @throws ApiError
     */
    public getRepositoryDirectory(
        projectId: string,
        path: string,
        branch?: string,
    ): CancelablePromise<DirectoryInfo> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/repository/directory/{path}',
            path: {
                'projectId': projectId,
                'path': path,
            },
            query: {
                'branch': branch,
            },
            errors: {
                400: `Bad Request`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get metadata about a file in the repository
     * @param projectId
     * @param path
     * @param branch
     * @returns FileMeta OK
     * @throws ApiError
     */
    public getRepositoryFileMeta(
        projectId: string,
        path: string,
        branch?: string,
    ): CancelablePromise<FileMeta> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/repository/filemeta/{path}',
            path: {
                'projectId': projectId,
                'path': path,
            },
            query: {
                'branch': branch,
            },
            errors: {
                400: `Bad Request`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get file contents as byte stream
     * @param projectId
     * @param path
     * @param branch
     * @returns binary File contents
     * @throws ApiError
     */
    public getRepositoryFile(
        projectId: string,
        path: string,
        branch?: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{projectId}/repository/file/{path}',
            path: {
                'projectId': projectId,
                'path': path,
            },
            query: {
                'branch': branch,
            },
            errors: {
                400: `Bad Request`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
}
