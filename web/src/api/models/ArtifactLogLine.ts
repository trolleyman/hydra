/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ArtifactLogLine = {
    /**
     * One captured output line (no trailing newline)
     */
    text: string;
    /**
     * Which stream the line came from; stderr is rendered in red
     */
    stream: ArtifactLogLine.stream;
};
export namespace ArtifactLogLine {
    /**
     * Which stream the line came from; stderr is rendered in red
     */
    export enum stream {
        STDOUT = 'stdout',
        STDERR = 'stderr',
    }
}

