/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The raw [resources] cgroup limits for ONE config layer (project / user / local), as edited in the Settings scope tabs. Applied to every scoped workload of the project (agent, preview, service, artifact) via its transient systemd scope. Every field is nullable; a null field is unset at this layer and inherits the layer below (built-in defaults - weights on 50/50, hard caps off - are applied only when resolving). Weights are soft (bite only under contention); the hard caps apply even on an idle box and may be silently skipped where their cgroup controller is not delegated to the user systemd manager.
 */
export type ResourceLimits = {
    /**
     * Relative CPU share under contention (systemd CPUWeight, 1-10000). null uses the default (50).
     */
    cpu_weight?: number | null;
    /**
     * Relative block-IO share under contention (systemd IOWeight, 1-10000). null uses the default (50).
     */
    io_weight?: number | null;
    /**
     * Hard CPU cap in percent of one core (systemd CPUQuota; 200 = 2 cores). null/0 = no cap.
     */
    cpu_quota?: number | null;
    /**
     * Hard memory ceiling in MB (systemd MemoryMax); the cgroup is OOM-killed past it. null/0 = no cap.
     */
    memory_max?: number | null;
    /**
     * Hard cap on processes/threads (systemd TasksMax); guards against fork bombs / PID exhaustion. null/0 = no cap.
     */
    tasks_max?: number | null;
    /**
     * Hard read ceiling in MB/s for the device backing the project root (systemd IOReadBandwidthMax, i.e. cgroup io.max). null/0 = no cap.
     */
    io_read_bandwidth_max?: number | null;
    /**
     * Hard write ceiling in MB/s (systemd IOWriteBandwidthMax, i.e. cgroup io.max). Unlike io_weight this needs no particular IO scheduler, so it is the cap that reliably bites - weights are inert unless the host uses bfq or blk-iocost. null/0 = no cap.
     */
    io_write_bandwidth_max?: number | null;
};

