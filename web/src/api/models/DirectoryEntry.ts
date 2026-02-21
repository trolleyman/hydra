/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type DirectoryEntry = {
    name: string;
    type: DirectoryEntry.type;
    size?: number | null;
};
export namespace DirectoryEntry {
    export enum type {
        FILE = 'file',
        DIRECTORY = 'directory',
        SYMLINK = 'symlink',
    }
}

