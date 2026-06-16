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
     * Human-readable project name (last path component)
     */
    name: string;
    /**
     * Whether the project's .hydra/config.toml is currently trusted by the user. True when there is no project config (nothing repo-controlled to execute) or when the current config's content matches what the user accepted. False means the user must review and trust the config before agents can be spawned or host artifact commands can run.
     */
    trusted: boolean;
};

