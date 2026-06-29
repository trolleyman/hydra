/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type NetworkConfig = {
    /**
     * Whether outbound network access is allowed (default true)
     */
    enabled?: boolean | null;
    /**
     * Whether the allowed_hosts list is enforced (deny-by-default egress). Null/unset = inferred (on when allowed_hosts is non-empty); true = only allowed_hosts reachable (empty list blocks all egress); false = allow every host.
     */
    filter_enabled?: boolean | null;
    /**
     * Outbound host allow-list (exact host or *.suffix), enforced by the egress proxy when filter_enabled is on.
     */
    allowed_hosts?: Array<string> | null;
};

