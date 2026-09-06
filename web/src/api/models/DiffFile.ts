/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DiffHunk } from './DiffHunk';
export type DiffFile = {
    /**
     * File path (new path for renamed files)
     */
    path: string;
    /**
     * Original file path (only set for renamed files)
     */
    old_path?: string | null;
    change_type: DiffFile.change_type;
    /**
     * Number of added lines
     */
    additions: number;
    /**
     * Number of deleted lines
     */
    deletions: number;
    /**
     * True if this is a binary file
     */
    binary: boolean;
    /**
     * True when hunks contain the file's entire content as a single whole-file hunk (full_context view), so the client can drive the context reveal/collapse model without re-fetching. Absent/false means the file is shown at the requested windowed context.
     */
    expanded?: boolean;
    /**
     * Total number of lines in the whole file on the head side (the old side for a deletion), when the server knows it. A windowed file carries only fragments, so this is the one thing the client cannot derive from the hunks - and without it the expander below the last hunk cannot say how many lines it hides. Absent when the file was never read in full (its change count exceeded max_full_changes, or the full-context read failed), in which case that expander stays a directional action without a Show all action.
     */
    total_lines?: number;
    /**
     * git blob sha of the file's content on the head side of the comparison (from the head tree, or a hash-object of the working-tree file for an uncommitted diff). Absent for a deletion or when it can't be resolved. The client keys per-file "viewed" state on it, so a file re-shows as unviewed exactly when its content changes.
     */
    head_blob_sha?: string | null;
    hunks: Array<DiffHunk>;
};
export namespace DiffFile {
    export enum change_type {
        ADDED = 'added',
        MODIFIED = 'modified',
        DELETED = 'deleted',
        RENAMED = 'renamed',
    }
}

