/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApprovalDecisionRequest = {
    /**
     * The user's verdict for the parked tool call
     */
    decision: ApprovalDecisionRequest.decision;
    /**
     * When true and decision is allow, persist the grant to the trusted config. With deny for a WebFetch or egress host, persist the host to the project local network block-list. Otherwise host denials suppress prompts for five minutes.
     */
    remember?: boolean;
    /**
     * For a host_command approval only: the exact command text the UI displayed and the user approved. The daemon runs THIS text verbatim (never re-reading the head-writable request file), which closes the TOCTOU window where an agent could swap the command after the user saw it. Ignored for every other kind.
     */
    command?: string;
    /**
     * For a filesystem_read approval only: the canonical host path the UI displayed and the user approved. The daemon grants this echoed path, never the target in the agent-writable request file.
     */
    path?: string;
};
export namespace ApprovalDecisionRequest {
    /**
     * The user's verdict for the parked tool call
     */
    export enum decision {
        ALLOW = 'allow',
        DENY = 'deny',
    }
}

