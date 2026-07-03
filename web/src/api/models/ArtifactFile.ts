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
     * Labels for this file, read from a sibling JSON sidecar (<file>.meta, {"tags": [...]}). A "category::value" tag is a scoped label - only one value per category survives. Drives the artifacts panel's tag badges and filter. Null/absent when the file has no tags.
     */
    tags?: Array<string> | null;
    /**
     * True only for a video file reported as "modified" whose verdict is a raw byte-hash comparison because ffmpeg was unavailable to verify it frame-by-frame - so the change may be spurious (e.g. only container metadata differs). Absent/false for images and for frame-verified video. The UI shows a caveat badge when set.
     */
    unverified?: boolean | null;
    /**
     * Fraction (0..1) of the media that differs between the two versions, for a "modified" file. For images it is the share of pixels whose RGBA differs; for video the share of frames whose content hash differs (per-frame granularity, since ffmpeg hashes whole frames). 0 means pixel/frame-identical (such a file is reported "unchanged" instead), 1 a wholesale change (e.g. differing dimensions). Lets the UI apply a "% changed" threshold below which a change is treated as identical. Absent for added/removed/unchanged files and for video left byte-compared (see unverified).
     */
    change_ratio?: number | null;
    /**
     * Frame rate of a video file, read from its sibling JSON sidecar (<file>.meta, {"fps": 60}). HTML5 video exposes no frame rate, so the viewer's frame-step buttons use it to size a single-frame step. Null/absent when the sidecar omits it, in which case the viewer assumes a sensible default. Only meaningful for video files.
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
    /**
     * Pixel density (device-scale factor) the media was captured at, read from its sidecar (<file>.meta, {"dpi": 2}). The grid sizes a tile by the media's logical width (width / dpi) so a shot captured at 2x lays out the same as the same shot at 1x - only crisper. Null/absent → 1.
     */
    dpi?: number | null;
};
export namespace ArtifactFile {
    export enum change_type {
        ADDED = 'added',
        REMOVED = 'removed',
        MODIFIED = 'modified',
        UNCHANGED = 'unchanged',
    }
}

