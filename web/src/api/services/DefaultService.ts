/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddProjectRequest } from '../models/AddProjectRequest';
import type { AgentInputRequest } from '../models/AgentInputRequest';
import type { AgentResponse } from '../models/AgentResponse';
import type { ApprovalDecisionRequest } from '../models/ApprovalDecisionRequest';
import type { ApprovalListResponse } from '../models/ApprovalListResponse';
import type { ArtifactsResponse } from '../models/ArtifactsResponse';
import type { ClaudeUsageResponse } from '../models/ClaudeUsageResponse';
import type { CommitInfo } from '../models/CommitInfo';
import type { CommitRepositoryRequest } from '../models/CommitRepositoryRequest';
import type { ConfigResponse } from '../models/ConfigResponse';
import type { ConfigTomlResponse } from '../models/ConfigTomlResponse';
import type { DiffResponse } from '../models/DiffResponse';
import type { GeneratedTitleResponse } from '../models/GeneratedTitleResponse';
import type { ListReviewsResponse } from '../models/ListReviewsResponse';
import type { NewReviewCommentRequest } from '../models/NewReviewCommentRequest';
import type { PreviewsResponse } from '../models/PreviewsResponse';
import type { PreviewStatus } from '../models/PreviewStatus';
import type { ProjectInfo } from '../models/ProjectInfo';
import type { ReorderProjectsRequest } from '../models/ReorderProjectsRequest';
import type { RepositoryArtifactResponse } from '../models/RepositoryArtifactResponse';
import type { RepositoryArtifactsResponse } from '../models/RepositoryArtifactsResponse';
import type { RepositoryBranchesResponse } from '../models/RepositoryBranchesResponse';
import type { RepositoryFileResponse } from '../models/RepositoryFileResponse';
import type { RepositoryPushStatus } from '../models/RepositoryPushStatus';
import type { RepositoryTreeResponse } from '../models/RepositoryTreeResponse';
import type { ResolvedPathResponse } from '../models/ResolvedPathResponse';
import type { ReviewConfigResponse } from '../models/ReviewConfigResponse';
import type { ReviewReplyRequest } from '../models/ReviewReplyRequest';
import type { ReviewThreadsResponse } from '../models/ReviewThreadsResponse';
import type { ServiceStatusResponse } from '../models/ServiceStatusResponse';
import type { SetProjectHiddenRequest } from '../models/SetProjectHiddenRequest';
import type { SetProjectIconRequest } from '../models/SetProjectIconRequest';
import type { SpawnAgentRequest } from '../models/SpawnAgentRequest';
import type { StatusResponse } from '../models/StatusResponse';
import type { TestsResponse } from '../models/TestsResponse';
import type { TrackRemoteResponse } from '../models/TrackRemoteResponse';
import type { UpdateAgentRequest } from '../models/UpdateAgentRequest';
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
     * Get cached Claude Code subscription usage
     * Probes the locally-installed Claude CLI (`claude /usage`) for the account's subscription quota and returns a cached snapshot. Probing starts a Claude CLI under a PTY for a few seconds, so it is rationed: a snapshot is served for ~10 minutes before a request is allowed to re-probe, a request arriving while a probe is in flight is served the cached snapshot rather than queued, and repeated failures back off and then park the probe (retried every few hours rather than every few minutes). Pass refresh=true to force a fresh probe, which skips the cache and the backoff; forced probes are still floored at one per 30s.
     *
     * @param refresh Bypass the cache and re-probe the CLI.
     * @returns ClaudeUsageResponse OK
     * @throws ApiError
     */
    public getClaudeUsage(
        refresh?: boolean,
    ): CancelablePromise<ClaudeUsageResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/usage/claude',
            query: {
                'refresh': refresh,
            },
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
     * Reorder the project list (the order the project selector shows)
     * @param requestBody
     * @returns void
     * @throws ApiError
     */
    public reorderProjects(
        requestBody: ReorderProjectsRequest,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'PUT',
            url: '/api/projects/order',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Remove a project from Hydra (does not delete files on disk)
     * @param projectId
     * @returns void
     * @throws ApiError
     */
    public removeProject(
        projectId: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{project_id}',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Set (or clear) a project's custom icon
     * @param projectId
     * @param requestBody
     * @returns ProjectInfo OK
     * @throws ApiError
     */
    public setProjectIcon(
        projectId: string,
        requestBody: SetProjectIconRequest,
    ): CancelablePromise<ProjectInfo> {
        return this.httpRequest.request({
            method: 'PUT',
            url: '/api/projects/{project_id}/icon',
            path: {
                'project_id': projectId,
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
     * Hide a project from the project lists (or show it again)
     * @param projectId
     * @param requestBody
     * @returns void
     * @throws ApiError
     */
    public setProjectHidden(
        projectId: string,
        requestBody: SetProjectHiddenRequest,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'PUT',
            url: '/api/projects/{project_id}/hidden',
            path: {
                'project_id': projectId,
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
     * Ensure the local "hydra-agents" git remote exists so the user can check out and follow head branches
     * @param projectId
     * @returns TrackRemoteResponse OK
     * @throws ApiError
     */
    public ensureTrackRemote(
        projectId: string,
    ): CancelablePromise<TrackRemoteResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/track-remote',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the raw .hydra/config.toml content for the trust prompt the UI shows on first open
     * @param projectId
     * @returns ConfigTomlResponse OK
     * @throws ApiError
     */
    public getProjectConfigToml(
        projectId: string,
    ): CancelablePromise<ConfigTomlResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/config-toml',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Preview the .hydra/config.toml at a filesystem path for the add-project trust prompt (read-only, does not register the project)
     * @param path
     * @returns ConfigTomlResponse OK
     * @throws ApiError
     */
    public previewConfigToml(
        path: string,
    ): CancelablePromise<ConfigTomlResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/config-toml-preview',
            query: {
                'path': path,
            },
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Resolve a hand-typed folder path to an absolute one (expands "~" and resolves relative paths against home) and report what is there
     * @param path
     * @returns ResolvedPathResponse OK
     * @throws ApiError
     */
    public resolvePath(
        path: string,
    ): CancelablePromise<ResolvedPathResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/resolve-path',
            query: {
                'path': path,
            },
            errors: {
                400: `Bad Request`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List all Hydra agents (heads)
     * @param projectId Project ID to scope the agent list
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public listAgents(
        projectId: string,
    ): CancelablePromise<Array<AgentResponse>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Spawn a new Hydra agent
     * @param projectId Project ID to spawn the agent in
     * @param requestBody
     * @returns AgentResponse Created
     * @throws ApiError
     */
    public spawnAgent(
        projectId: string,
        requestBody: SpawnAgentRequest,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents',
            path: {
                'project_id': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request`,
                404: `Project Not Found`,
                409: `Conflict (a head with this ID already exists - active, archived, or in another project)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List archived (killed/merged) Hydra agents, newest first
     * Returns a page of finished agents retained for the browsable history list. Supports limit/offset for infinite scroll.
     * @param projectId Project ID to scope the archived agent list
     * @param limit Maximum number of archived agents to return (page size). Omit or <=0 for all.
     * @param offset Number of archived agents to skip (for pagination).
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public listArchivedAgents(
        projectId: string,
        limit?: number,
        offset?: number,
    ): CancelablePromise<Array<AgentResponse>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/archived',
            path: {
                'project_id': projectId,
            },
            query: {
                'limit': limit,
                'offset': offset,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Restart a Hydra agent (kill and respawn with the same prompt)
     * @param projectId Project ID
     * @param id
     * @returns AgentResponse OK (Agent restarted, new agent returned)
     * @throws ApiError
     */
    public restartAgent(
        projectId: string,
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/restart',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Restart just the agent process (keeps the worktree, branch and conversation)
     * Stops the running CLI process (claude/codex/...) and relaunches it in a fresh sandbox, resuming the same conversation. Unlike restartAgent this does no teardown: the worktree, branch, DB record and transcript are untouched.
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public restartAgentSession(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/restart-session',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (agent is archived, or an operation is in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Resume an archived (killed/merged) agent, restoring its conversation
     * Revives a killed or merged agent: recreates its worktree and branch off the current base, un-archives the record, and relaunches the agent so it continues from its saved conversation transcript (the file changes start fresh on a clean branch). Depends on the host conversation transcript still existing.
     * @param projectId Project ID
     * @param id
     * @returns AgentResponse OK (Agent resumed, revived live agent returned)
     * @throws ApiError
     */
    public resumeAgent(
        projectId: string,
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/resume',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found (no archived agent with that ID)`,
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Merge a Hydra agent's branch into its base branch and, unless close=false, kill it
     * @param projectId Project ID
     * @param id
     * @param force Bypass the test gate (PLAN #68). Without it, a merge is soft-blocked with 409 tests_failing / tests_errored when the head's configured tests are failing, errored, or still running. force=true merges anyway - covering both "don't wait" (tests still running) and "override" (tests red). Merge-conflict and operation-in-progress checks still apply.
     * @param close Whether to tear the agent down after the merge. Default (true) merges the branch and closes the head - session killed, worktree and branch removed, archived as "merged". close=false merges the branch but keeps the agent running: session, worktree, branch and uncommitted work all survive, and the agent's diff resets to only the work not yet merged. The test gate and conflict checks apply the same either way.
     * @returns void
     * @throws ApiError
     */
    public mergeAgent(
        projectId: string,
        id: string,
        force?: boolean,
        close: boolean = true,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/merge',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'force': force,
                'close': close,
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
     * Publish a Hydra agent's branch as a forge MR/PR (create or update the link)
     * Host-side, by the daemon, with the user's own credentials (docs/non-local-integration.md). Claims the head (publishing), runs the local test gate (like merge; force bypasses), pushes hydra/<id> to the downstream branch on the remote, then creates the MR/PR if none exists. The local branch is untouched. Idempotent: re-publishing pushes again and the MR follows. Returns the updated agent with its review link.
     * @param projectId
     * @param id
     * @param force Bypass the local test gate (same semantics as merge's force).
     * @param requestBody
     * @returns AgentResponse Published (returns the updated agent with its review link).
     * @throws ApiError
     */
    public publishAgent(
        projectId: string,
        id: string,
        force?: boolean,
        requestBody?: {
            /**
             * Branch name to push AS. Defaults to the head's downstream_branch (seeded from review.push_branch_template).
             */
            downstream_branch?: string;
            /**
             * Git remote to push to. Defaults to review.remote.
             */
            remote?: string;
            /**
             * MR target branch. Defaults to the head's base branch.
             */
            target_branch?: string;
            title?: string;
            description?: string;
            draft?: boolean;
        },
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/publish',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'force': force,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request (no branch, provider not configured, push auth failed)`,
                404: `Not Found`,
                409: `Conflict (operation in progress, tests failing, or push rejected)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Push the local head branch to its linked MR's downstream branch (Push to MR)
     * @param projectId
     * @param id
     * @returns AgentResponse Pushed (returns the updated agent).
     * @throws ApiError
     */
    public pushToMr(
        projectId: string,
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/publish-push',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                400: `Bad Request (not linked, no branch, or push auth failed)`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Pull the remote downstream branch into the local head branch (Pull from MR)
     * Fetches, then merges the remote-tracking downstream ref INTO the head branch (merge-not-rebase, same as update-from-base). Conflicts surface as 409.
     * @param projectId
     * @param id
     * @returns AgentResponse Pulled (returns the updated agent).
     * @throws ApiError
     */
    public pullFromMr(
        projectId: string,
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/publish-pull',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                400: `Bad Request (not linked or no branch)`,
                404: `Not Found`,
                409: `Conflict (merge conflict pulling the remote in)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Set a head's downstream branch name (the name it is pushed AS)
     * @param projectId
     * @param id
     * @param requestBody
     * @returns AgentResponse Updated (returns the updated agent).
     * @throws ApiError
     */
    public setDownstreamBranch(
        projectId: string,
        id: string,
        requestBody: {
            downstream_branch: string;
        },
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'PATCH',
            url: '/api/projects/{project_id}/agents/{id}/downstream-branch',
            path: {
                'project_id': projectId,
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request (invalid branch name, or soft-locked after publish without confirm)`,
                404: `Not Found`,
            },
        });
    }
    /**
     * The review threads on this head's MR, for the diff viewer
     * Returns the forge's review conversations for this head's linked MR, anchored to file/line, with Hydra's local-only notes merged in (docs/review-threads.md). Fetched live from the forge host-side; if that call fails the last cached threads are returned with stale=true and an error hint, so the diff still renders. An unlinked head returns an empty list.
     *
     * @param projectId
     * @param id
     * @returns ReviewThreadsResponse The head's review threads (empty when unlinked).
     * @throws ApiError
     */
    public getReviewThreads(
        projectId: string,
        id: string,
    ): CancelablePromise<ReviewThreadsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/review/threads',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
            },
        });
    }
    /**
     * Start a new review thread on a line of this head's MR
     * Posts a new review comment on the MR's diff, as the user, host-side via gh/glab. The line is a NEW-side line number. Fails cleanly when the head has no MR, when the line is not part of the MR's diff, or when the forge CLI is unauthenticated.
     *
     * @param projectId
     * @param id
     * @param requestBody
     * @returns ReviewThreadsResponse Posted (returns the refreshed threads).
     * @throws ApiError
     */
    public createReviewComment(
        projectId: string,
        id: string,
        requestBody: NewReviewCommentRequest,
    ): CancelablePromise<ReviewThreadsResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/review/threads',
            path: {
                'project_id': projectId,
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request (unlinked head, empty body, or the forge rejected it)`,
                404: `Not Found`,
            },
        });
    }
    /**
     * Reply to a review thread on this head's MR
     * Adds a reply to an existing thread. `local: true` keeps the reply inside Hydra (visible in the diff viewer, never sent to the forge); otherwise it is posted to the forge as the user. Agents only ever write local notes, and they do so through their MCP tool rather than this endpoint.
     *
     * @param projectId
     * @param id
     * @param threadId
     * @param requestBody
     * @returns ReviewThreadsResponse Replied (returns the refreshed threads).
     * @throws ApiError
     */
    public replyToReviewThread(
        projectId: string,
        id: string,
        threadId: string,
        requestBody: ReviewReplyRequest,
    ): CancelablePromise<ReviewThreadsResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/review/threads/{thread_id}/reply',
            path: {
                'project_id': projectId,
                'id': id,
                'thread_id': threadId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request (unlinked head, empty body, or the forge rejected it)`,
                404: `Not Found`,
            },
        });
    }
    /**
     * List existing PRs/MRs on the project's forge, for the adoption picker
     * Enumerates open PRs/MRs (via gh/glab) so a head can be spawned onto one (docs/pr-adoption.md). Host-side, using the user's forge CLI auth. Never fails hard - an unconfigured/unauthenticated forge returns configured/authenticated flags and an error hint with an empty list.
     * @param projectId
     * @param state "open" (default) | "all" | "merged" | "closed".
     * @param author "@me" to list only the authenticated user's own PRs.
     * @param search Free-text search (forge-native syntax).
     * @param limit
     * @returns ListReviewsResponse OK
     * @throws ApiError
     */
    public listReviews(
        projectId: string,
        state?: string,
        author?: string,
        search?: string,
        limit?: number,
    ): CancelablePromise<ListReviewsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/reviews',
            path: {
                'project_id': projectId,
            },
            query: {
                'state': state,
                'author': author,
                'search': search,
                'limit': limit,
            },
            errors: {
                404: `Not Found`,
            },
        });
    }
    /**
     * Resolved [review] config + live forge auth status for a project
     * The effective, resolved review settings (provider auto-detected from the remote URL) plus the forge CLI's live auth status, for the Settings Review section and the Create MR dialog prefill.
     * @param projectId
     * @returns ReviewConfigResponse OK
     * @throws ApiError
     */
    public getReviewConfig(
        projectId: string,
    ): CancelablePromise<ReviewConfigResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/review-config',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Not Found`,
            },
        });
    }
    /**
     * Update a Hydra agent's branch from its base branch (merge base into head)
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public updateAgentFromBase(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/update-from-base',
            path: {
                'project_id': projectId,
                'id': id,
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
     * @param projectId Project ID
     * @param id
     * @returns CommitInfo OK
     * @throws ApiError
     */
    public getAgentCommits(
        projectId: string,
        id: string,
    ): CancelablePromise<Array<CommitInfo>> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/commits',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the diff for an agent's branch
     * @param projectId Project ID
     * @param id
     * @param baseRef Base commit SHA or ref. Defaults to the agent's base branch.
     * @param headRef Head commit SHA or ref. Defaults to the agent's branch.
     * @param ignoreWhitespace Ignore whitespace changes in the diff
     * @param includeUncommitted Include uncommitted changes in the worktree in the diff
     * @param path Only return the diff for this specific file path
     * @param context Number of lines of context to show (defaults to 3)
     * @param fullContext Return each file's full content (so the client can expand context without further round-trips), in a single request for all files. Files larger than max_full_lines are returned at the normal context instead. Combined with path it expands just that file, which is how the client promotes a single big file (left windowed by the bulk caps) once the reader expands it - pass caps above the bulk ones.
     * @param maxFullChanges Only auto-expand files with at most this many changed lines. Larger files (which the client also hides by default) keep the normal context so their full content isn't shipped until requested. Only meaningful with full_context.
     * @param maxFullLines Upper bound on the full content shipped per expanded file. A file whose whole content exceeds this stays at the normal context. Only meaningful with full_context.
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getAgentDiff(
        projectId: string,
        id: string,
        baseRef?: string,
        headRef?: string,
        ignoreWhitespace?: boolean,
        includeUncommitted?: boolean,
        path?: string,
        context: number = 3,
        fullContext?: boolean,
        maxFullChanges: number = 1000,
        maxFullLines: number = 6000,
    ): CancelablePromise<DiffResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/diff',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'base_ref': baseRef,
                'head_ref': headRef,
                'ignore_whitespace': ignoreWhitespace,
                'include_uncommitted': includeUncommitted,
                'path': path,
                'context': context,
                'full_context': fullContext,
                'max_full_changes': maxFullChanges,
                'max_full_lines': maxFullLines,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the list of changed files for an agent's branch
     * @param projectId Project ID
     * @param id
     * @param baseRef Base commit SHA or ref. Defaults to the agent's base branch.
     * @param headRef Head commit SHA or ref. Defaults to the agent's branch.
     * @param includeUncommitted Include uncommitted changes in the worktree
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getAgentDiffFiles(
        projectId: string,
        id: string,
        baseRef?: string,
        headRef?: string,
        includeUncommitted?: boolean,
    ): CancelablePromise<DiffResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/diff-files',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
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
     * Get generated visual artifacts (e.g. screenshots) for both sides of a diff
     * Returns, per configured artifact script, the generated image files for the left and right versions of the comparison and whether they differ. Generation runs in the background and is cached; a script with status "generating" should be polled. Returns an empty list when the project configures no artifact scripts.
     *
     * @param projectId Project ID
     * @param id
     * @param baseRef Left (base) commit SHA or ref. Defaults to the agent's base branch.
     * @param headRef Right (head) commit SHA or ref. Defaults to the agent's branch tip.
     * @param includeUncommitted Use the agent's uncommitted working tree as the right version.
     * @param refresh Name of a single artifact script whose cached result (including a cached failure) should be discarded and regenerated before responding. By default both sides of the comparison are regenerated; pass refresh_side to regenerate just one.
     *
     * @param refreshSide Limits a refresh to a single side - "left" (before) or "right" (after). Ignored unless refresh names a script; when omitted both sides are regenerated.
     *
     * @returns ArtifactsResponse OK
     * @throws ApiError
     */
    public getAgentArtifacts(
        projectId: string,
        id: string,
        baseRef?: string,
        headRef?: string,
        includeUncommitted?: boolean,
        refresh?: string,
        refreshSide?: 'left' | 'right',
    ): CancelablePromise<ArtifactsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/artifacts',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'base_ref': baseRef,
                'head_ref': headRef,
                'include_uncommitted': includeUncommitted,
                'refresh': refresh,
                'refresh_side': refreshSide,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List live server previews ([previews.<name>]) for a head
     * Returns, per configured [previews.<name>] script, the preview instance status for the requested version (the head's uncommitted working tree or a specific commit - the same selection contract as the artifacts and tests endpoints), plus any still-running instances of those scripts at other versions. Purely a read: nothing is spawned. Returns an empty list when the project configures no server scripts.
     *
     * @param projectId Project ID
     * @param id
     * @param headRef Commit SHA or ref to preview. Defaults to the agent's branch tip.
     * @param includeUncommitted Preview the agent's uncommitted working tree (its live worktree).
     * @returns PreviewsResponse OK
     * @throws ApiError
     */
    public getAgentPreviews(
        projectId: string,
        id: string,
        headRef?: string,
        includeUncommitted?: boolean,
    ): CancelablePromise<PreviewsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/previews',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
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
     * Start (or ensure) a live server preview instance
     * Ensures the named preview script has a proxy listener for the requested version and spawns its server if not already running. Returns the instance status including the URL to open; the server may still be "starting" (building) - opening the URL shows a live loading page until it is ready.
     *
     * @param projectId Project ID
     * @param id
     * @param name The preview script name
     * @param headRef Commit SHA or ref to preview. Defaults to the agent's branch tip.
     * @param includeUncommitted Preview the agent's uncommitted working tree (its live worktree).
     * @returns PreviewStatus OK
     * @throws ApiError
     */
    public startAgentPreview(
        projectId: string,
        id: string,
        name: string,
        headRef?: string,
        includeUncommitted?: boolean,
    ): CancelablePromise<PreviewStatus> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/previews/{name}/start',
            path: {
                'project_id': projectId,
                'id': id,
                'name': name,
            },
            query: {
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
     * Stop a live server preview instance
     * Tears down the named preview's server process for the requested version (the listener persists, so a later start or visit respawns it). A no-op if nothing is running.
     *
     * @param projectId Project ID
     * @param id
     * @param name The preview script name
     * @param headRef Commit SHA or ref whose instance to stop. Defaults to the agent's branch tip.
     * @param includeUncommitted Stop the instance for the agent's uncommitted working tree.
     * @returns void
     * @throws ApiError
     */
    public stopAgentPreview(
        projectId: string,
        id: string,
        name: string,
        headRef?: string,
        includeUncommitted?: boolean,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/previews/{name}/stop',
            path: {
                'project_id': projectId,
                'id': id,
                'name': name,
            },
            query: {
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
     * Get the test-runner verdict(s) for a head's branch
     * Returns, per configured [tests.<name>] runner, the parsed pass/fail verdict for the head's current commit (or working tree). Generation runs in the background and is cached per commit SHA; a runner with status "running" should be polled. Returns an empty list when the project configures no test runners. Single-sided - there is no before/after comparison (PLAN #68).
     *
     * @param projectId Project ID
     * @param id
     * @param headRef Commit SHA or ref to test. Defaults to the agent's branch tip.
     * @param includeUncommitted Test the agent's uncommitted working tree instead of a commit.
     * @param refresh Name of a single test runner whose cached result (including a cached failure) should be discarded and re-run before responding.
     * @returns TestsResponse OK
     * @throws ApiError
     */
    public getAgentTests(
        projectId: string,
        id: string,
        headRef?: string,
        includeUncommitted?: boolean,
        refresh?: string,
    ): CancelablePromise<TestsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/tests',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'head_ref': headRef,
                'include_uncommitted': includeUncommitted,
                'refresh': refresh,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Arm auto-merge - merge this head when its tests settle passing
     * Arms "merge when green" (PLAN #68): the daemon merges this head as soon as its tests settle passing, and disarms it (with a notification) if they settle failing/errored. Arming kicks a fresh test run if none is in flight. Idempotent.
     *
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public armMergeWhenGreen(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/merge-when-green',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Disarm auto-merge for a head
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public disarmMergeWhenGreen(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{project_id}/agents/{id}/merge-when-green',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Arm publish-when-green - auto-open a draft MR / auto-push when tests settle passing
     * Arms "publish when green" (docs/non-local-integration.md): once local tests settle passing and the agent has finished, an unlinked head auto-opens a draft MR and a linked head auto-pushes (plain push only). Idempotent. Arming an ADOPTED PR - one Hydra did not create - additionally requires acknowledge_adopted=true, since it starts pushing into someone else's PR (docs/pr-adoption.md); without it such a head is refused with a 400.
     *
     * @param projectId
     * @param id
     * @param acknowledgeAdopted Acknowledges that this head is working on a PR Hydra did not create, so arming means auto-pushing into someone else's PR on every green commit. Required (true) to arm an adopted head; ignored for any other head. A read-only adopted PR (no maintainer edits) is refused even with it, since no push can succeed.
     *
     * @returns void
     * @throws ApiError
     */
    public armPublishWhenGreen(
        projectId: string,
        id: string,
        acknowledgeAdopted?: boolean,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/publish-when-green',
            path: {
                'project_id': projectId,
                'id': id,
            },
            query: {
                'acknowledge_adopted': acknowledgeAdopted,
            },
            errors: {
                400: `Bad Request (e.g. an adopted PR without acknowledge_adopted, or a read-only one)`,
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Disarm publish-when-green for a head
     * @param projectId
     * @param id
     * @returns void
     * @throws ApiError
     */
    public disarmPublishWhenGreen(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{project_id}/agents/{id}/publish-when-green',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Send text input to an agent's terminal stdin
     * @param projectId Project ID
     * @param id
     * @param requestBody
     * @returns any OK
     * @throws ApiError
     */
    public sendAgentInput(
        projectId: string,
        id: string,
        requestBody: AgentInputRequest,
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/input',
            path: {
                'project_id': projectId,
                'id': id,
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
     * List the agent's pending security-gate approval requests
     * @param projectId Project ID
     * @param id
     * @returns ApprovalListResponse OK
     * @throws ApiError
     */
    public listAgentApprovals(
        projectId: string,
        id: string,
    ): CancelablePromise<ApprovalListResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}/approvals',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Resolve a pending security-gate approval (allow/deny, optionally remember)
     * @param projectId Project ID
     * @param id
     * @param reqid The approval request ID
     * @param requestBody
     * @returns void
     * @throws ApiError
     */
    public decideAgentApproval(
        projectId: string,
        id: string,
        reqid: string,
        requestBody: ApprovalDecisionRequest,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/approvals/{reqid}',
            path: {
                'project_id': projectId,
                'id': id,
                'reqid': reqid,
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
     * Mark an agent as read, clearing its unread-changes flag
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public markAgentRead(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/read',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Mark an agent as unread, raising its unread-changes flag
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public markAgentUnread(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/unread',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Generate a title for an agent from its task prompt
     * Asks a cheap one-shot LLM call to summarise the agent's original task prompt into a short title - the same call the spawn flow makes in the background. This only RETURNS the title; it does not persist it, so the rename box can drop it in as a draft the user can edit or discard. Blocking (a few seconds) and best-effort: 502 means the model was unreachable or answered with something that doesn't read as a title.
     * @param projectId Project ID
     * @param id
     * @returns GeneratedTitleResponse OK
     * @throws ApiError
     */
    public generateAgentTitle(
        projectId: string,
        id: string,
    ): CancelablePromise<GeneratedTitleResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{id}/generate-title',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                400: `Bad Request (e.g. the agent has no task prompt to summarise)`,
                404: `Not Found`,
                500: `Internal Server Error`,
                502: `Bad Gateway (the title model failed or gave an unusable answer)`,
            },
        });
    }
    /**
     * Get the merged configuration
     * @param projectId Project ID
     * @param scope Load only a specific scope's raw config instead of the merged config (local = the untracked per-user .hydra/config.local.toml)
     * @returns ConfigResponse OK
     * @throws ApiError
     */
    public getConfig(
        projectId: string,
        scope?: 'project' | 'user' | 'local',
    ): CancelablePromise<ConfigResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/config',
            path: {
                'project_id': projectId,
            },
            query: {
                'scope': scope,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Save configuration changes
     * @param projectId Project ID
     * @param requestBody
     * @param scope Which config file to save to - project (.hydra/config.toml), user (~/.config/hydra/config.toml) or local (the untracked per-user .hydra/config.local.toml). Defaults to project.
     * @returns any OK
     * @throws ApiError
     */
    public saveConfig(
        projectId: string,
        requestBody: ConfigResponse,
        scope?: 'project' | 'user' | 'local',
    ): CancelablePromise<any> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/config',
            path: {
                'project_id': projectId,
            },
            query: {
                'scope': scope,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get the live status of the project's supervised services
     * @param projectId Project ID
     * @returns ServiceStatusResponse OK
     * @throws ApiError
     */
    public getServices(
        projectId: string,
    ): CancelablePromise<ServiceStatusResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/services',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project Not Found`,
            },
        });
    }
    /**
     * Restart the project's supervised services (picks up config changes)
     * @param projectId Project ID
     * @returns ServiceStatusResponse OK
     * @throws ApiError
     */
    public restartServices(
        projectId: string,
    ): CancelablePromise<ServiceStatusResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/services/restart',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project Not Found`,
            },
        });
    }
    /**
     * List the files tracked in the project's repository
     * @param projectId Project ID
     * @param ref Git ref to read the tree from (defaults to HEAD)
     * @returns RepositoryTreeResponse OK
     * @throws ApiError
     */
    public getRepositoryTree(
        projectId: string,
        ref?: string,
    ): CancelablePromise<RepositoryTreeResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/tree',
            path: {
                'project_id': projectId,
            },
            query: {
                'ref': ref,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Diff two refs in the project's repository
     * Returns the diff between two arbitrary refs (branches or commits) in the project's repository. Used by the repository browser's diff view to compare the branch being viewed against another branch. Uses a two-dot diff (base..head) - the literal difference between the two trees.
     * @param projectId Project ID
     * @param baseRef Base ref (branch or commit) to diff from
     * @param headRef Head ref (branch or commit) to diff to
     * @param ignoreWhitespace Ignore whitespace changes in the diff
     * @param path Only return the diff for this specific file path
     * @param context Number of lines of context to show (defaults to 3)
     * @param fullContext Return each file's full content (so the client can expand context without further round-trips), in a single request for all files. Files larger than max_full_lines are returned at the normal context instead. Combined with path it expands just that file, which is how the client promotes a single big file (left windowed by the bulk caps) once the reader expands it - pass caps above the bulk ones.
     * @param maxFullChanges Only auto-expand files with at most this many changed lines. Only meaningful with full_context.
     * @param maxFullLines Upper bound on the full content shipped per expanded file. Only meaningful with full_context.
     * @returns DiffResponse OK
     * @throws ApiError
     */
    public getRepositoryDiff(
        projectId: string,
        baseRef: string,
        headRef: string,
        ignoreWhitespace?: boolean,
        path?: string,
        context: number = 3,
        fullContext?: boolean,
        maxFullChanges: number = 1000,
        maxFullLines: number = 6000,
    ): CancelablePromise<DiffResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/diff',
            path: {
                'project_id': projectId,
            },
            query: {
                'base_ref': baseRef,
                'head_ref': headRef,
                'ignore_whitespace': ignoreWhitespace,
                'path': path,
                'context': context,
                'full_context': fullContext,
                'max_full_changes': maxFullChanges,
                'max_full_lines': maxFullLines,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Read the contents of a file in the project's repository
     * @param projectId Project ID
     * @param path Repo-relative path of the file to read
     * @param ref Git ref to read the file from (defaults to HEAD)
     * @returns RepositoryFileResponse OK
     * @throws ApiError
     */
    public getRepositoryFile(
        projectId: string,
        path: string,
        ref?: string,
    ): CancelablePromise<RepositoryFileResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/file',
            path: {
                'project_id': projectId,
            },
            query: {
                'path': path,
                'ref': ref,
            },
            errors: {
                404: `Project or file not found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * List the branches available for the project's repository
     * @param projectId Project ID
     * @returns RepositoryBranchesResponse OK
     * @throws ApiError
     */
    public getRepositoryBranches(
        projectId: string,
    ): CancelablePromise<RepositoryBranchesResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/branches',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Report whether the repository's current branch has commits to push
     * Inspects the project root's currently checked-out branch and reports how far it is ahead of the remote it would be pushed to. Uses the last-known remote-tracking refs and does NOT contact the network, mirroring how `git status` reports ahead/behind. The sidebar uses this to enable or disable the Push button.
     * @param projectId Project ID
     * @returns RepositoryPushStatus OK
     * @throws ApiError
     */
    public getRepositoryPushStatus(
        projectId: string,
    ): CancelablePromise<RepositoryPushStatus> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/push-status',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Push the repository's current branch to its remote
     * Pushes the project root's currently checked-out branch to the remote it tracks (or origin), setting upstream tracking if not already configured. Requires network access; runs in the daemon, outside any agent sandbox. Returns the refreshed push status, with ahead normally back to zero.
     * @param projectId Project ID
     * @returns RepositoryPushStatus OK (branch pushed)
     * @throws ApiError
     */
    public pushRepository(
        projectId: string,
    ): CancelablePromise<RepositoryPushStatus> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/repository/push',
            path: {
                'project_id': projectId,
            },
            errors: {
                400: `Bad Request (nothing to push, detached HEAD, or no remote)`,
                404: `Project Not Found`,
                500: `Internal Server Error (e.g. push rejected or auth failure)`,
            },
        });
    }
    /**
     * Synchronise the repository's current branch with its remote
     * Fetches, integrates the remote's commits into the local branch (a pull: fast-forward or merge), then pushes any local commits. The one-click "sync" the sidebar button performs. Requires network access; runs in the daemon, outside any agent sandbox. Returns the refreshed push status, normally with both ahead and behind back to zero.
     * @param projectId Project ID
     * @returns RepositoryPushStatus OK (branch synced)
     * @throws ApiError
     */
    public syncRepository(
        projectId: string,
    ): CancelablePromise<RepositoryPushStatus> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/repository/sync',
            path: {
                'project_id': projectId,
            },
            errors: {
                400: `Bad Request (detached HEAD or no remote)`,
                404: `Project Not Found`,
                409: `Conflict (the pull could not be merged cleanly)`,
                500: `Internal Server Error (e.g. fetch/push rejected or auth failure)`,
            },
        });
    }
    /**
     * Commit the given uncommitted paths in the project root
     * Stages exactly the requested paths (tracked and untracked) and commits them with the given message; other dirty paths are left untouched. Backs the sidebar's uncommitted-changes warning, whose main job is sweeping up config edits the web UI itself writes to .hydra/config.toml - the UI sends the paths it showed the user. Requested paths that are no longer dirty are skipped. Returns the refreshed push status.
     * @param projectId Project ID
     * @param requestBody
     * @returns RepositoryPushStatus OK (changes committed)
     * @throws ApiError
     */
    public commitRepository(
        projectId: string,
        requestBody: CommitRepositoryRequest,
    ): CancelablePromise<RepositoryPushStatus> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/repository/commit',
            path: {
                'project_id': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Bad Request (no paths given, none still dirty, or empty message)`,
                404: `Project Not Found`,
                500: `Internal Server Error (e.g. the commit itself failed)`,
            },
        });
    }
    /**
     * List the artifact scripts configured at a ref
     * Lists the names of the enabled [artifacts.<name>] scripts defined in the ref's .hydra/config.toml. This is cheap - it only reads config and does NOT generate anything. The repository browser uses it to decide whether to show the dynamic ".hydra/artifacts" folder and what to list inside it.
     * @param projectId Project ID
     * @param ref Git ref whose config to read (defaults to HEAD)
     * @returns RepositoryArtifactsResponse OK
     * @throws ApiError
     */
    public getRepositoryArtifacts(
        projectId: string,
        ref?: string,
    ): CancelablePromise<RepositoryArtifactsResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/artifacts',
            path: {
                'project_id': projectId,
            },
            query: {
                'ref': ref,
            },
            errors: {
                404: `Project Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Generate (or load) one artifact script's output for a ref
     * Runs (or returns the cached result of) the named [artifacts.<name>] script against a single ref and reports its outputs single-sided (no diff - the repository browser shows one ref at a time). Generation is lazy: this is only called when the user opens the script in the browser.
     * @param projectId Project ID
     * @param name The artifact script name
     * @param ref Git ref to generate the artifact for (defaults to HEAD)
     * @param refresh When true, discard the cached result and regenerate (chiefly to retry a cached failure)
     * @returns RepositoryArtifactResponse OK
     * @throws ApiError
     */
    public getRepositoryArtifact(
        projectId: string,
        name: string,
        ref?: string,
        refresh?: boolean,
    ): CancelablePromise<RepositoryArtifactResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/artifacts/{name}',
            path: {
                'project_id': projectId,
                'name': name,
            },
            query: {
                'ref': ref,
                'refresh': refresh,
            },
            errors: {
                404: `Project not found, or no such script configured at the ref`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Get a specific Hydra agent by ID
     * @param projectId Project ID
     * @param id
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public getAgent(
        projectId: string,
        id: string,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{id}',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Update a Hydra agent's mutable fields (currently its title)
     * @param projectId Project ID
     * @param id
     * @param requestBody
     * @returns AgentResponse OK
     * @throws ApiError
     */
    public updateAgent(
        projectId: string,
        id: string,
        requestBody: UpdateAgentRequest,
    ): CancelablePromise<AgentResponse> {
        return this.httpRequest.request({
            method: 'PATCH',
            url: '/api/projects/{project_id}/agents/{id}',
            path: {
                'project_id': projectId,
                'id': id,
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
     * Kill a Hydra agent by ID
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public killAgent(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{project_id}/agents/{id}',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Permanently delete an agent (kill it and erase every record, including its Claude session history)
     * Irreversibly removes the agent: stops any live session, removes its worktree/branch and on-disk status files, deletes its Claude session-history directory, and hard-deletes the database record so it no longer appears even in the archived-history list. Works on both live and archived agents.
     * @param projectId Project ID
     * @param id
     * @returns void
     * @throws ApiError
     */
    public purgeAgent(
        projectId: string,
        id: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'DELETE',
            url: '/api/projects/{project_id}/agents/{id}/purge',
            path: {
                'project_id': projectId,
                'id': id,
            },
            errors: {
                404: `Not Found`,
                409: `Conflict (operation already in progress)`,
                500: `Internal Server Error`,
            },
        });
    }
}
