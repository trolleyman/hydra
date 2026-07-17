/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ProjectInfo = {
    /**
     * Unique project identifier (derived from folder name)
     */
    id: string;
    /**
     * Absolute filesystem path to the project root
     */
    path: string;
    /**
     * The project path for display, with the server's home directory abbreviated to "~" (e.g. "~/code/hydra"). Computed server-side because only the server knows its HOME. Falls back to `path` verbatim when the path is not under HOME.
     */
    display_path?: string;
    /**
     * Human-readable project name (last path component)
     */
    name: string;
    /**
     * Optional custom project icon that replaces the default folder glyph. Interpreted by its content by the web UI: an emoji is rendered as-is; a lucide-react icon name (e.g. "Rocket") renders that icon; a value ending in an image extension (.png/.svg/.ico/.jpg/...) is an image - an http(s) or data: URI is used directly, any other value is a path served from the project by the backend. Empty = the default folder icon.
     */
    icon?: string;
    /**
     * Number of this project's agents with unread changes. Drives the cross-project "updates waiting" indicator.
     */
    unread_count?: number;
    /**
     * Number of this project's agents currently blocked on the user (status `needs_input`). Drives the red "needs your input" indicator, which is shown whenever this is greater than zero.
     */
    needs_input_count?: number;
    /**
     * Total number of this project's active (non-ephemeral, non-archived) agents. Drives the project switcher's per-project agent tally.
     */
    agent_count?: number;
    /**
     * Number of this project's active agents currently in the `running` status.
     */
    running_count?: number;
    /**
     * Number of this project's active agents currently in the `waiting` (gone quiet) status.
     */
    waiting_count?: number;
    /**
     * Number of this project's active agents currently in the `finished` status (done but not yet archived).
     */
    finished_count?: number;
};

