/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One durable normalized event. `seq` is per-head, monotonic, and the sole wire and cursor identity - provider object ids stay inside `payload`.
 */
export type ChatEvent = {
    /**
     * Per-head sequence number; also the history cursor.
     */
    seq: number;
    /**
     * Ingestion identity used to deduplicate. Re-reading a transcript window or re-observing a line appends nothing new.
     */
    source_id?: string;
    /**
     * The event kind, e.g. conversation_started, user_message, assistant_delta, assistant_message, reasoning_completed, reasoning_duration, tool_started, tool_completed, subagent_started, subagent_completed, plan_updated, commit_created, head_changed, notice, interaction_requested, messages_retracted, turn_started, turn_completed, turn_failed, turn_interrupted.
     */
    type: string;
    timestamp: string;
    /**
     * The event's fields, which vary by `type`. Deliberately open: the provider's own recorded entry rides here too, so the Raw panel can show what the provider actually sent.
     */
    payload?: Record<string, any>;
};

