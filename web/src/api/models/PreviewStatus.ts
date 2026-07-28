/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogLine } from './ArtifactLogLine';
import type { PreviewState } from './PreviewState';
/**
 * Snapshot of one live server-preview instance (or a configured-but-never-started script)
 */
export type PreviewStatus = {
    /**
     * The preview script name
     */
    name: string;
    state: PreviewState;
    /**
     * Which checkout the instance serves - "uncommitted" (the head's live worktree) or a short commit SHA
     */
    version: string;
    /**
     * Absolute URL of the preview (built from the request host and the instance's proxy port); null until a listener exists
     */
    url?: string | null;
    /**
     * Child process PID while starting/running (0 otherwise)
     */
    pid?: number;
    /**
     * In-flight proxied requests, including open WebSocket tunnels
     */
    connections?: number;
    /**
     * When the current child was spawned (null when stopped)
     */
    started_at?: string | null;
    /**
     * Latest ::hydra:progress:: headline while starting
     */
    progress?: string;
    /**
     * Failure detail when state is "error"
     */
    message?: string;
    /**
     * "Latest changes" channel only - the live worktree changed since this server was built, so a build-then-serve preview is out of date (restart to rebuild)
     */
    stale?: boolean;
    /**
     * Most recent captured output lines of the current/last spawn
     */
    log?: Array<ArtifactLogLine>;
};

