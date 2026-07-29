/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A resource changed; refetch it. Carries no payload.
 */
export type ResourceChangedEvent = {
    type: ResourceChangedEvent.type;
};
export namespace ResourceChangedEvent {
    export enum type {
        AGENTS_CHANGED = 'agents_changed',
        PROJECTS_CHANGED = 'projects_changed',
        SERVICES_CHANGED = 'services_changed',
        PUSH_STATUS_CHANGED = 'push_status_changed',
    }
}

