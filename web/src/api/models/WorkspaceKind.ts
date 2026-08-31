/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Checkout topology used by a Head. Worktree Heads own an isolated branch and linked worktree; project-directory Heads use the registered project root and remain branchless.
 */
export enum WorkspaceKind {
    WorkspaceKindWorktree = 'worktree',
    WorkspaceKindProjectDirectory = 'project_directory',
}
