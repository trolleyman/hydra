/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddProjectRequest } from '../models/AddProjectRequest';
import type { AgentInputRequest } from '../models/AgentInputRequest';
import type { AgentResponse } from '../models/AgentResponse';
import type { CommitInfo } from '../models/CommitInfo';
import type { ConfigResponse } from '../models/ConfigResponse';
import type { DiffResponse } from '../models/DiffResponse';
import type { ProjectInfo } from '../models/ProjectInfo';
import type { SpawnAgentRequest } from '../models/SpawnAgentRequest';
import type { StatusResponse } from '../models/StatusResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class DefaultService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Chrome DevTools workspace configuration
     * @returns any OK
     * @throws ApiError
     */
    public getDevToolsConfig(): CancelablePromise<{
        workspace?: {
            root?: string;
            uuid?: string;
        };
    }> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/.well-known/appspecific/com.chrome.devtools.json',
            errors: {
                403: `Not running in dev mode`,
            },
        });
    }
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
     * Trigger a server rebuild and restart (dev mode only)
     * @returns any Restart initiated
     * @throws ApiError
     */
    public devRestart(): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/dev/restart',
            errors: {
                403: `Not running in dev mode`,
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
     * Restart a Hydra agent (kill and respawn with the same prompt)
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns AgentResponse OK (Agent restarted, new agent returned)
     * @throws ApiError
     */
    public restartAgent(
        id: string,
        projectId?: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agent/{id}/restart',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Merge a Hydra agent's branch into its base branch and kill it
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns void
     * @throws ApiError
     */
    public mergeAgent(
        id: string,
        projectId?: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agent/{id}/merge',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                400: `Bad Request (e.g. no branch to merge)`,
                404: `Not Found`,
                409: `Conflict (operation already in progress or merge conflicts)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Update a Hydra agent's branch from its base branch (merge base into head)
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns void
     * @throws ApiError
     */
    public updateAgentFromBase(
        id: string,
        projectId?: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agent/{id}/update-from-base',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (merge conflicts)`,
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
     * @param includeUncommitted Include uncommitted changes in the worktree in the diff
     * @param path Only return the diff for this specific file path
     * @param context Number of lines of context to show (defaults to 3)
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getAgentDiff(
        id: string,
        projectId?: string,
        baseRef?: string,
        headRef?: string,
        ignoreWhitespace?: boolean,
        includeUncommitted?: boolean,
        path?: string,
        context: number = 3,
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
                'include_uncommitted': includeUncommitted,
                'path': path,
                'context': context,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the list of changed files for an agent's branch
     * @param id
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @param baseRef Base commit SHA or ref. Defaults to the agent's base branch.
     * @param headRef Head commit SHA or ref. Defaults to the agent's branch.
     * @param includeUncommitted Include uncommitted changes in the worktree
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getAgentDiffFiles(
        id: string,
        projectId?: string,
        baseRef?: string,
        headRef?: string,
        includeUncommitted?: boolean,
    ): CancelablePromise<DiffResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/agent/{id}/diff-files',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
                'base_ref': baseRef,
                'head_ref': headRef,
                'include_uncommitted': includeUncommitted,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Send text input to an agent's terminal stdin
     * @param id
     * @param requestBody
     * @param projectId Project ID to scope the lookup (defaults to server CWD project)
     * @returns any OK
     * @throws ApiError
     */
    public sendAgentInput(
        id: string,
        requestBody: AgentInputRequest,
        projectId?: string,
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/agent/{id}/input',
            path: {
                'id': id,
            },
            query: {
                'project_id': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the merged configuration
     * @param projectId Project ID to scope the config (defaults to server CWD project)
     * @param scope Load only a specific scope's raw config instead of the merged config
     * @returns ConfigResponse OK
     * @throws ApiError
     */
    public getConfig(
        projectId?: string,
        scope?: 'project' | 'user',
    ): CancelablePromise<ConfigResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/config',
            query: {
                'project_id': projectId,
                'scope': scope,
            },
            errors: {
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Save configuration changes
     * @param requestBody
     * @param projectId Project ID to save the config to (defaults to server CWD project)
     * @param scope Whether to save to the project or user config file (defaults to project)
     * @returns any OK
     * @throws ApiError
     */
    public saveConfig(
        requestBody: ConfigResponse,
        projectId?: string,
        scope?: 'project' | 'user',
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/config',
            query: {
                'project_id': projectId,
                'scope': scope,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
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
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
}
