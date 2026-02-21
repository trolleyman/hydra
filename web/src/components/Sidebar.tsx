import { Link, useMatchRoute } from '@tanstack/react-router';
import type { Agent } from '../api';
import { AgentStatusBadge } from './AgentStatusBadge';

interface Props {
  projectId: string;
  agents?: Agent[];
}

export function Sidebar({ projectId, agents }: Props) {
  const matchRoute = useMatchRoute();

  const navItem = (
    to: string,
    params: Record<string, string>,
    label: string,
    icon: React.ReactNode,
  ) => {
    const active = !!matchRoute({ to, params });
    return (
      <Link
        to={to}
        params={params}
        className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
          active
            ? 'bg-blue-50 text-blue-700 font-medium'
            : 'text-gray-700 hover:bg-gray-100'
        }`}
      >
        {icon}
        {label}
      </Link>
    );
  };

  return (
    <aside className="w-56 shrink-0 flex flex-col gap-1 pt-4 pb-4 px-2">
      {navItem(
        '/$projectId',
        { projectId },
        'Overview',
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>,
      )}
      {navItem(
        '/$projectId/agents',
        { projectId },
        'Agents',
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
        </svg>,
      )}
      {navItem(
        '/$projectId/repository',
        { projectId },
        'Repository',
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>,
      )}

      {agents && agents.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200">
          <p className="px-3 py-1 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Agents
          </p>
          {agents.slice(0, 10).map((agent) => (
            <Link
              key={agent.id}
              to="/$projectId/agents/$agentId"
              params={{ projectId, agentId: agent.id }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100"
            >
              <AgentStatusBadge status={agent.status} />
              <span className="truncate text-xs">{agent.name}</span>
            </Link>
          ))}
        </div>
      )}
    </aside>
  );
}
