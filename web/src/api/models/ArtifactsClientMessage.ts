/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactSide } from './ArtifactSide';
/**
 * Client to server. Only `refresh` is supported - regenerate one script, or with a side, just that side, leaving the other cached.
 */
export type ArtifactsClientMessage = {
    type: ArtifactsClientMessage.type;
    script: string;
    side?: ArtifactSide;
};
export namespace ArtifactsClientMessage {
    export enum type {
        REFRESH = 'refresh',
    }
}

