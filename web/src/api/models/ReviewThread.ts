/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewThreadNote } from './ReviewThreadNote';
/**
 * One review conversation, anchored to a file/line where the forge reports one.
 */
export type ReviewThread = {
    /**
     * Thread handle used for replies (GitHub - the root comment id; GitLab - the discussion id).
     */
    id: string;
    path: string;
    /**
     * NEW-side line the thread anchors to (0 when the forge reports none).
     */
    line: number;
    /**
     * First NEW-side line covered by the comment. Omitted for a single-line comment.
     */
    start_line?: number;
    /**
     * Resolved, by the forge's own flag OR Hydra's local mark (see resolved_locally).
     */
    resolved?: boolean;
    /**
     * Resolved in Hydra only - the forge still shows it open, because Hydra never writes a resolve to a PR.
     */
    resolved_locally?: boolean;
    /**
     * The anchor line no longer exists in the MR's diff.
     */
    outdated?: boolean;
    url?: string;
    notes: Array<ReviewThreadNote>;
};

