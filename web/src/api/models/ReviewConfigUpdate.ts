/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Review fields to write to config.local.toml. Every field is optional; an omitted field is left as-is (inherits config.toml / the built-in default).
 */
export type ReviewConfigUpdate = {
    /**
     * "auto" | "github" | "gitlab".
     */
    provider?: string;
    remote?: string;
    target_branch?: string;
    /**
     * "merge" | "create_mr".
     */
    default_action?: string;
    push_branch_template?: string;
    draft?: boolean;
    squash?: boolean;
    delete_remote_branch?: boolean;
    require_local_tests?: boolean;
    publish_when_green?: boolean;
};

