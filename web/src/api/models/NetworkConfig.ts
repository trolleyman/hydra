/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type NetworkConfig = {
    /**
     * Egress posture: "off" (no network), "unrestricted" (network, no host filtering), "advisory" (proxy-only host filtering - every honest client is filtered, but escapable), or "hard" (inescapable pasta+nft netns, failing closed where the tooling is unavailable unless strict=false; "on" is a synonym for "hard"). Null/unset = default ("hard"). Supersedes the legacy enabled/filter_enabled booleans.
     */
    mode?: NetworkConfig.mode | null;
    /**
     * With mode "hard", fail closed (block all egress) when the inescapable boundary can't be built, instead of degrading to advisory (default true).
     */
    strict?: boolean | null;
    /**
     * LEGACY (use mode). Honoured only when mode is unset.
     */
    enabled?: boolean | null;
    /**
     * LEGACY (use mode). Honoured only when mode is unset.
     */
    filter_enabled?: boolean | null;
    /**
     * Extra outbound hosts (exact host or *.suffix) allowed when filtering is on, unioned on top of the built-in default allow-list.
     */
    allowed_hosts?: Array<string> | null;
    /**
     * Outbound hosts (exact host or *.suffix) denied even when otherwise allowed - overrides both allowed_hosts and the built-in defaults.
     */
    blocked_hosts?: Array<string> | null;
    /**
     * Host-loopback TCP ports reachable from the sandbox even under mode "hard", whose network namespace otherwise cuts off the host's 127.0.0.1 - for host-local daemons that hardcode loopback, e.g. adb's server on 5037. No effect in other modes (they share the host loopback already).
     */
    allowed_loopback_ports?: Array<number> | null;
};
export namespace NetworkConfig {
    /**
     * Egress posture: "off" (no network), "unrestricted" (network, no host filtering), "advisory" (proxy-only host filtering - every honest client is filtered, but escapable), or "hard" (inescapable pasta+nft netns, failing closed where the tooling is unavailable unless strict=false; "on" is a synonym for "hard"). Null/unset = default ("hard"). Supersedes the legacy enabled/filter_enabled booleans.
     */
    export enum mode {
        OFF = 'off',
        UNRESTRICTED = 'unrestricted',
        ADVISORY = 'advisory',
        HARD = 'hard',
        ON = 'on',
    }
}

