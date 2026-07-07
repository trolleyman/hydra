/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The raw [review] config for ONE config layer (project / user / local), as edited in the Settings scope tabs. Every field is nullable; a null field is unset at this layer and inherits the layer below (built-in defaults are applied only in the resolved ReviewConfigResponse). Which file a save writes to is chosen by the scope tab, so provider/target/etc. can live in the shared config.toml and personal overrides in config.local.toml.
 */
export type ReviewConfig = {
    /**
     * "auto" | "github" | "gitlab".
     */
    provider?: string | null;
    remote?: string | null;
    target_branch?: string | null;
    /**
     * "cli" | "token".
     */
    auth?: string | null;
    /**
     * "merge" | "create_mr".
     */
    default_action?: string | null;
    push_branch_template?: string | null;
    draft?: boolean | null;
    squash?: boolean | null;
    delete_remote_branch?: boolean | null;
    require_local_tests?: boolean | null;
    publish_when_green?: boolean | null;
    protected_branches?: Array<string> | null;
};

