/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DiffLine } from './DiffLine';
export type DiffHunk = {
    /**
     * The @@ ... @@ hunk header line
     */
    header: string;
    /**
     * Starting line number in the old file
     */
    old_start: number;
    /**
     * Starting line number in the new file
     */
    new_start: number;
    lines: Array<DiffLine>;
};

