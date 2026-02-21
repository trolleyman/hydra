import { Link } from '@tanstack/react-router';
import { Agent } from '../api';
import { AgentStatusBadge } from './AgentStatusBadge';

interface Props {
  agent: Agent;
  onDelete?: (agentId: string) => void;
  onMerge?: (agentId: string) => void;
}

export function AgentCard({ agent, onDelete, onMerge }: Props) {
  const promptExcerpt = agent.prompt.length > 100
    ? agent.prompt.slice(0, 100) + '…'
    : agent.prompt;

  const canMerge = agent.status === Agent.status.DONE;
  const canDelete = agent.status !== Agent.status.DELETED;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link
              to="/$projectId/agents/$agentId"
              params={{ projectId: agent.projectId, agentId: agent.id }}
              className="font-medium text-gray-900 hover:text-blue-600 truncate"
            >
              {agent.name}
            </Link>
            <AgentStatusBadge status={agent.status} />
          </div>
          <p className="text-sm text-gray-500 mb-2">{promptExcerpt}</p>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="font-mono">{agent.branch}</span>
            <span>{agent.aiProvider}</span>
            <span>{new Date(agent.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canMerge && onMerge && (
            <button
              onClick={() => onMerge(agent.id)}
              className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium"
            >
              Merge
            </button>
          )}
          {canDelete && onDelete && (
            <button
              onClick={() => onDelete(agent.id)}
              className="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 font-medium"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
