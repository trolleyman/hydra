/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ArtifactFile = {
    /**
     * File name relative to the artifact set
     */
    name: string;
    change_type: ArtifactFile.change_type;
    /**
     * URL of the file for the left version (null if absent on the left)
     */
    left_url?: string | null;
    /**
     * URL of the file for the right version (null if absent on the right)
     */
    right_url?: string | null;
    /**
     * Labels for this file, read from a sibling JSON sidecar (<file>.meta, {"tags": [...]}). A "category::value" tag is a scoped label — only one value per category survives. Drives the artifacts panel's tag badges and filter. Null/absent when the file has no tags.
     */
    tags?: Array<string> | null;
    /**
     * True only for a video file reported as "modified" whose verdict is a raw byte-hash comparison because ffmpeg was unavailable to verify it frame-by-frame — so the change may be spurious (e.g. only container metadata differs). Absent/false for images and for frame-verified video. The UI shows a caveat badge when set.
     */
    unverified?: boolean | null;
    /**
     * Frame rate of a video file, read from its sibling JSON sidecar (<file>.meta, {"fps": 60}). HTML5 video exposes no frame rate, so the viewer's frame-step buttons use it to size a single-frame step. Null/absent when the sidecar omits it, in which case the viewer assumes a sensible default. Only meaningful for video files.
     */
    fps?: number | null;
};
export namespace ArtifactFile {
    export enum change_type {
        ADDED = 'added',
        REMOVED = 'removed',
        MODIFIED = 'modified',
        UNCHANGED = 'unchanged',
    }
}

