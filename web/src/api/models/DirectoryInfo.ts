/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DirectoryEntry } from './DirectoryEntry';
export type DirectoryInfo = {
    path: string;
    branch?: string | null;
    entries: Array<DirectoryEntry>;
    /**
     * Contents of README.md or README.txt if present
     */
    readme?: string | null;
};

