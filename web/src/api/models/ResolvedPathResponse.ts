/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ResolvedPathResponse = {
    /**
     * The absolute path the input resolves to ("~/x" and relative paths both resolve against the server's home directory)
     */
    path: string;
    /**
     * The same path with the server's home directory abbreviated to "~"
     */
    display_path: string;
    /**
     * Whether anything exists at the resolved path
     */
    exists: boolean;
    /**
     * Whether the resolved path is a directory
     */
    is_dir: boolean;
    /**
     * Whether the resolved path is inside a git repository
     */
    is_git_repo: boolean;
    /**
     * Root of the git repository containing the path, when is_git_repo (the project would be added at this path)
     */
    repo_root?: string;
};

