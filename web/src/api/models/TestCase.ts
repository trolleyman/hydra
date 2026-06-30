/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestCaseStatus } from './TestCaseStatus';
export type TestCase = {
    name: string;
    status: TestCaseStatus;
    duration_ms?: number;
    /**
     * Failure/assertion text for a failed case (or skip reason for a skipped one)
     */
    message?: string | null;
};

