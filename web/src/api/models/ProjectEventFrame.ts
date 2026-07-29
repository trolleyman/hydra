/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatusChangedEvent } from './AgentStatusChangedEvent';
import type { AgentTestsChangedEvent } from './AgentTestsChangedEvent';
import type { ResourceChangedEvent } from './ResourceChangedEvent';
/**
 * One change signal. No `discriminator` here: the four bare refetch nudges share one schema, and a discriminator mapping several type values onto the same member is not expressible - openapi-typescript-codegen collapses the enum to whichever mapping it saw last. A plain oneOf narrows on `type` correctly because every member's is a literal or a closed enum.
 */
export type ProjectEventFrame = (ResourceChangedEvent | AgentTestsChangedEvent | AgentStatusChangedEvent);

