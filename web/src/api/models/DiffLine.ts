/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type DiffLine = {
    /**
     * context: unchanged line; addition: added line; deletion: removed line; no_newline: no newline at end of file
     */
    type: DiffLine.type;
    /**
     * Line content without the diff prefix character
     */
    content: string;
    /**
     * Line number in the old file (null for additions)
     */
    old_line_num?: number | null;
    /**
     * Line number in the new file (null for deletions)
     */
    new_line_num?: number | null;
};
export namespace DiffLine {
    /**
     * context: unchanged line; addition: added line; deletion: removed line; no_newline: no newline at end of file
     */
    export enum type {
        CONTEXT = 'context',
        ADDITION = 'addition',
        DELETION = 'deletion',
        NO_NEWLINE = 'no_newline',
    }
}

