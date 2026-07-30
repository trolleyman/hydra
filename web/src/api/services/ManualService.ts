/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogResponse } from '../models/ArtifactLogResponse';
import type { FolderPickerAvailableResponse } from '../models/FolderPickerAvailableResponse';
import type { FolderPickerOpenResponse } from '../models/FolderPickerOpenResponse';
import type { UploadResponse } from '../models/UploadResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class ManualService {
    constructor(public readonly httpRequest: BaseHttpRequest) {}
    /**
     * Serve a project's icon image, when its icon is a local file path
     * @param projectId
     * @returns binary The icon's bytes. Content-Type is sniffed per file.
     * @throws ApiError
     */
    public getProjectIconImage(
        projectId: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/icon',
            path: {
                'project_id': projectId,
            },
            errors: {
                404: `Project not found, or its icon is not a local image file - an emoji, a lucide icon name, and an http(s)/data URI all 404 here, because the browser renders those directly and never points an <img> at this route.`,
            },
        });
    }
    /**
     * Serve one file from a generated artifact (raw bytes)
     * @param projectId Project ID
     * @param script Artifact script name, sanitized as it is on disk
     * @param keyKind Which kind of cache key this is. A commit is keyed by resolved SHA, the working tree by a content fingerprint; they live in separate self-describing subtrees.
     * @param keyId The key's hex id - a commit SHA or a worktree content hash
     * @param file Artifact-relative path of the file. MAY CONTAIN SLASHES - see the note above this path. Confined to the artifact's directory server-side.
     * @returns binary The file's bytes. Content-Type is derived per file, and download-class artifacts (.apk, .zip) also get a Content-Disposition.
     * @throws ApiError
     */
    public getArtifactBlob(
        projectId: string,
        script: string,
        keyKind: 'commit' | 'worktree',
        keyId: string,
        file: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/artifacts/{script}/{key_kind}/{key_id}/files/{file}',
            path: {
                'project_id': projectId,
                'script': script,
                'key_kind': keyKind,
                'key_id': keyId,
                'file': file,
            },
            errors: {
                400: `Invalid artifact request (bad key, unsupported type, escaping path)`,
                404: `Project, artifact or file not found`,
            },
        });
    }
    /**
     * Read a settled artifact generation's captured build log
     * @param projectId Project ID
     * @param script Artifact script name, sanitized as it is on disk
     * @param keyKind Cache-key kind
     * @param keyId The key's hex id
     * @returns ArtifactLogResponse OK
     * @throws ApiError
     */
    public getArtifactLog(
        projectId: string,
        script: string,
        keyKind: 'commit' | 'worktree',
        keyId: string,
    ): CancelablePromise<ArtifactLogResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/artifacts/{script}/{key_kind}/{key_id}/log',
            path: {
                'project_id': projectId,
                'script': script,
                'key_kind': keyKind,
                'key_id': keyId,
            },
            errors: {
                404: `Project or log not found`,
            },
        });
    }
    /**
     * Read a settled test run's captured output
     * @param projectId Project ID
     * @param runner Test runner name
     * @param key Test cache key
     * @returns ArtifactLogResponse OK
     * @throws ApiError
     */
    public getTestLog(
        projectId: string,
        runner: string,
        key: string,
    ): CancelablePromise<ArtifactLogResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/tests/log',
            path: {
                'project_id': projectId,
            },
            query: {
                'runner': runner,
                'key': key,
            },
            errors: {
                404: `Project or log not found`,
            },
        });
    }
    /**
     * Serve a file from the project's repository (raw bytes)
     * @param projectId Project ID
     * @param path Repo-relative path of the file to serve
     * @param ref Git ref to read from (defaults to HEAD)
     * @returns binary The file's bytes. Content-Type is sniffed per file.
     * @throws ApiError
     */
    public getRepositoryBlob(
        projectId: string,
        path: string,
        ref?: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/repository/blob',
            path: {
                'project_id': projectId,
            },
            query: {
                'path': path,
                'ref': ref,
            },
            errors: {
                404: `Project or file not found`,
            },
        });
    }
    /**
     * Serve a file from a head's worktree (raw bytes)
     * @param projectId Project ID
     * @param agentId Head ID
     * @param path Repo-relative path of the file to serve
     * @returns binary The file's bytes. Content-Type is sniffed per file.
     * @throws ApiError
     */
    public getAgentRepositoryBlob(
        projectId: string,
        agentId: string,
        path: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{agent_id}/repository/blob',
            path: {
                'project_id': projectId,
                'agent_id': agentId,
            },
            query: {
                'path': path,
            },
            errors: {
                404: `Project, head or file not found`,
            },
        });
    }
    /**
     * Serve a file a head referenced by local path (raw bytes)
     * @param projectId Project ID
     * @param agentId Head ID
     * @param path Absolute host path of the file. Resolved against an allow-list of roots (the head's worktree, the project's uploads dir, the head's private /tmp) and restricted to servable extensions.
     * @returns binary The file's bytes. Content-Type is sniffed per file.
     * @throws ApiError
     */
    public getAgentFileBlob(
        projectId: string,
        agentId: string,
        path: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/agents/{agent_id}/media/blob',
            path: {
                'project_id': projectId,
                'agent_id': agentId,
            },
            query: {
                'path': path,
            },
            errors: {
                400: `No file path given`,
                404: `Project, head or file not found, or the path is outside every allowed root`,
            },
        });
    }
    /**
     * Upload a pasted or attached file
     * @param projectId Project ID
     * @param formData
     * @returns UploadResponse OK
     * @throws ApiError
     */
    public uploadFile(
        projectId: string,
        formData: {
            /**
             * The file's bytes. Capped at 25MB.
             */
            file: Blob;
        },
    ): CancelablePromise<UploadResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/uploads',
            path: {
                'project_id': projectId,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
            errors: {
                400: `Invalid or oversize upload`,
                404: `Project not found`,
                500: `Internal Server Error`,
            },
        });
    }
    /**
     * Serve a previously uploaded file (raw bytes)
     * @param projectId Project ID
     * @param name The upload's bare on-disk filename, no path. Validated against the names the uploader generates, so it cannot escape the uploads dir.
     * @returns binary The upload's bytes. Content-Type is sniffed per file.
     * @throws ApiError
     */
    public getUploadBlob(
        projectId: string,
        name: string,
    ): CancelablePromise<Blob> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/projects/{project_id}/uploads/blob',
            path: {
                'project_id': projectId,
            },
            query: {
                'name': name,
            },
            errors: {
                404: `Project or upload not found`,
            },
        });
    }
    /**
     * Terminate one web bash shell immediately
     * Closing a terminal tab kills its process now, instead of waiting out the idle grace period - which only covers reloads and transient disconnects.
     * @param projectId Project ID
     * @param agentId Head ID
     * @param shellId The shell's token, as used when opening its WebSocket
     * @param sandboxed Which of the head's two shells to close. Sandboxed and host shells are separate sessions with separate ids, so this has to match the one that was opened.
     * @returns void
     * @throws ApiError
     */
    public closeShell(
        projectId: string,
        agentId: string,
        shellId?: string,
        sandboxed: boolean = true,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{agent_id}/shell/close',
            path: {
                'project_id': projectId,
                'agent_id': agentId,
            },
            query: {
                'shell_id': shellId,
                'sandboxed': sandboxed,
            },
            errors: {
                400: `Agent ID required`,
            },
        });
    }
    /**
     * Terminate a head's review session immediately
     * The review slot is a second agent against the head's own detached checkout (docs/review-agent.md), so closing its tab has to end that session rather than the head's.
     * @param projectId Project ID
     * @param agentId Head ID - the slot is derived from it, not passed separately
     * @returns void
     * @throws ApiError
     */
    public closeReviewSession(
        projectId: string,
        agentId: string,
    ): CancelablePromise<void> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/projects/{project_id}/agents/{agent_id}/review/close',
            path: {
                'project_id': projectId,
                'agent_id': agentId,
            },
            errors: {
                400: `Agent ID required`,
                404: `Project not found`,
            },
        });
    }
    /**
     * Report whether a native folder dialog can be offered
     * @returns FolderPickerAvailableResponse OK
     * @throws ApiError
     */
    public getFolderPickerAvailable(): CancelablePromise<FolderPickerAvailableResponse> {
        return this.httpRequest.request({
            method: 'GET',
            url: '/api/folder-picker/available',
        });
    }
    /**
     * Open the native folder dialog and block until it is answered
     * @returns FolderPickerOpenResponse A folder was picked, or the dialog was dismissed
     * @throws ApiError
     */
    public openFolderPicker(): CancelablePromise<FolderPickerOpenResponse> {
        return this.httpRequest.request({
            method: 'POST',
            url: '/api/folder-picker/open',
            errors: {
                403: `Not a local client`,
                409: `A folder picker is already open`,
                503: `No native folder picker available on this system`,
            },
        });
    }
}
