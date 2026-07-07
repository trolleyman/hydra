/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Resolved [review] config for a project plus live forge auth status (NON_LOCAL_INTEGRATION.md 3.2).
 */
export type ReviewConfigResponse = {
    /**
     * True when a [review] section exists (or a provider could be resolved) so the Create MR affordance should be offered.
     */
    configured: boolean;
    /**
     * Resolved provider ("github" | "gitlab" | "") - empty when auto-detection could not decide.
     */
    provider: string;
    /**
     * The raw provider setting ("auto" | "github" | "gitlab").
     */
    provider_setting?: string;
    remote: string;
    /**
     * The URL of the configured remote (what provider detection ran against).
     */
    remote_url?: string;
    /**
     * Derived https browse URL for the repo (for the forge web link), or empty.
     */
    browse_url?: string;
    target_branch: string;
    /**
     * Auth method ("cli" | "token").
     */
    auth: string;
    /**
     * Live auth status line (e.g. "gh: logged in as X" / "glab: not authenticated").
     */
    auth_status?: string;
    /**
     * Whether the forge CLI is authenticated.
     */
    authenticated?: boolean;
    /**
     * Primary head action ("merge" | "create_mr").
     */
    default_action: string;
    push_branch_template?: string;
    draft?: boolean;
    squash?: boolean;
    delete_remote_branch?: boolean;
    require_local_tests?: boolean;
    /**
     * Default arming for new heads.
     */
    publish_when_green?: boolean;
    protected_branches?: Array<string>;
};

