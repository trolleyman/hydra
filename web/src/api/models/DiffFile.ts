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

