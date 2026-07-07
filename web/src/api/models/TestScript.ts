/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A per-project test-runner command whose pass/fail verdict gates the merge button ([tests.<name>] in config.toml, PLAN
 */
export type TestScript = {
    /**
     * Unique label, also used as the cache directory
     */
    name: string;
    /**
     * Shell command run via `bash -c` in the checkout directory; writes a JUnit-XML or Hydra-JSON report into $HYDRA_TEST_OUTPUT
     */
    command: string;
    /**
     * How results are read - "junit" (default; parse *.xml*.json report files from $HYDRA_TEST_OUTPUT after exit) or "stdout" (parse `::hydra:test:*::` markers streamed live from stdout; the accumulated cases are the report, no file needed).
     */
    type?: string | null;
    /**
     * Max seconds the command may run (0 = built-in default)
     */
    timeout_sec?: number;
    /**
     * Run on the host with NO sandbox - runs the diffed ref's test code; only for trusted refs (default false)
     */
    unsafe_host?: boolean;
    /**
     * Also delete git-ignored files before each run (git clean -fdx instead of -fd); slower (default false)
     */
    clean_ignored?: boolean;
    /**
     * Run the command under `set -eo pipefail` (absent/null or true = strict; false = run exactly as written). The verdict still comes from the parsed report, not the exit code.
     */
    strict?: boolean | null;
    /**
     * Whether the test gate runs this command (absent/null or true = enabled; false = skipped)
     */
    enabled?: boolean | null;
};

