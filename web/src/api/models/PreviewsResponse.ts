/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PreviewStatus } from './PreviewStatus';
export type PreviewsResponse = {
    /**
     * One entry per configured server script, for the requested version
     */
    previews: Array<PreviewStatus>;
    /**
     * Still-live instances of those scripts at other versions (e.g. the selection moved on)
     */
    others?: Array<PreviewStatus>;
};

