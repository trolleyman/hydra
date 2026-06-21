/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryArtifactFile = {
    /**
     * Output file's relative path (forward-slashed)
     */
    name: string;
    /**
     * URL to fetch the file's bytes (an artifacts blob URL); null while still generating
     */
    url?: string | null;
    /**
     * Labels for this file, read from a sibling JSON sidecar (<file>.meta, {"tags": [...]}). A "category::value" tag is a scoped label. Null/absent when the file has no tags.
     */
    tags?: Array<string> | null;
    /**
     * Frame rate of a video file, read from its sidecar; sizes the video viewer's frame-step.
     */
    fps?: number | null;
};

