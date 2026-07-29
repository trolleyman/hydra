/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The worktree changed; the diff viewer should re-fetch.
 */
export type TerminalDiffRefreshEvent = {
    type: 'diff_refresh';
    /**
     * True when this refresh was triggered by a new commit (HEAD moved), as opposed to an uncommitted working-tree change. The diff viewer uses it to also re-snapshot per-commit artifacts (screenshots), which are memoized by commit SHA, while a plain working-tree change only re-fetches the diff text.
     */
    head_moved: boolean;
};

