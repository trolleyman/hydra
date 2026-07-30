/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A pin on a generated artifact, the way path/line pin a comment to a diff. The position is normalized (0..1) because the same picture is laid out at different sizes and densities depending on the pane; natural_w/natural_h are kept alongside so real pixels can be recovered, which is the form an agent is told.
 *
 */
export type ReviewImageAnchor = {
    /**
     * The [artifacts.<name>] table the picture came from.
     */
    script?: string;
    /**
     * The artifact cache key of the pinned SIDE, verbatim - "commit/<sha>" or "worktree/<content-hash>". It says which commit the picture was rendered from, and stays honest when that side was the uncommitted working tree, which has no sha to report. Doubles as the entry's path on disk.
     *
     */
    key?: string;
    /**
     * Which half of the comparison was pinned.
     */
    side?: ReviewImageAnchor.side;
    /**
     * The output's name within the artifact, e.g. "home-dark.png".
     */
    file: string;
    /**
     * Pin position as a fraction (0..1) of the image's width.
     */
    'x': number;
    /**
     * Pin position as a fraction (0..1) of the image's height.
     */
    'y': number;
    /**
     * Box width as a fraction of the image's width. Present with h when a drag placed a box instead of a point.
     */
    'w'?: number;
    /**
     * Box height as a fraction of the image's height.
     */
    'h'?: number;
    /**
     * The picture's own pixel width, so the fractions can be turned back into pixels. Absent when it could not be determined.
     */
    natural_w?: number;
    /**
     * The picture's own pixel height.
     */
    natural_h?: number;
    /**
     * WRITE ONLY. A PNG data URL of the close-up around the pin, taken in the browser when the pin was placed - the picture analogue of a line comment's frozen diff block. Stored as a file beside the comment and served back as crop_url; it is never echoed here, because a response carrying a base64 image per comment would dwarf everything else in it.
     *
     */
    crop?: string;
    /**
     * READ ONLY. Where to fetch the stored close-up. Absent when the comment has none.
     */
    crop_url?: string;
    /**
     * For a VIDEO artifact, the moment the pin was placed at, in seconds from the start. A recording has a time axis as well as two spatial ones, so a position without it sends the reader hunting through the run. Absent for a still.
     *
     */
    't'?: number;
    /**
     * The file's content hash when the pin was placed - the picture's hunk_hash, so a regenerated artifact is detectable as having moved under the comment.
     */
    hash?: string;
};
export namespace ReviewImageAnchor {
    /**
     * Which half of the comparison was pinned.
     */
    export enum side {
        LEFT = 'left',
        RIGHT = 'right',
    }
}

