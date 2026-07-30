/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Effective safety ceilings resolved for the server machine and user config. CPU quotas use systemd's percent-of-one-core units (400 = four logical CPUs). Workloads retain explicit [resources] overrides, while machine and background values are aggregate parent-slice ceilings.
 */
export type ResourceCapacity = {
    logical_cpus: number;
    workload_cpu_quota: number;
    workload_io_read_max: number;
    workload_io_write_max: number;
    machine_cpu_quota: number;
    machine_io_read_max: number;
    machine_io_write_max: number;
    background_cpu_quota: number;
    background_io_read_max: number;
    background_io_write_max: number;
};

