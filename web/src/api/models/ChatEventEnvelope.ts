/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The fields every event carries, whatever its type.
 */
export type ChatEventEnvelope = {
    /**
     * Per-head sequence number; also the history cursor.
     */
    seq: number;
    /**
     * Ingestion identity used to deduplicate.
     */
    source_id?: string;
    timestamp: string;
};

