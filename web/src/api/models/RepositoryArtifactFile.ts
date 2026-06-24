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
    /**
     * Natural pixel width of the media, measured server-side at generation time (image header, or ffprobe for video) and cached in the entry's meta.json. Lets the grid lay out tiles without downloading every file to measure it, and avoids upscaling a low-resolution shot. Best-effort: null/absent when it could not be determined.
     */
    width?: number | null;
    /**
     * Natural pixel height of the media; see width. Null/absent when undetermined.
     */
    height?: number | null;
};

