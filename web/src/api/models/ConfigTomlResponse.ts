/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ConfigTomlResponse = {
    /**
     * Raw text of the project's .hydra/config.toml (empty when absent)
     */
    content: string;
    /**
     * Whether a .hydra/config.toml file is present in the project
     */
    exists: boolean;
    /**
     * Whether the user trusts this project
     */
    trusted: boolean;
};

