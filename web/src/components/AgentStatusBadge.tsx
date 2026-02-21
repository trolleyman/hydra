import { Agent } from '../api';

const statusConfig: Record<
  Agent.status,
  { label: string; className: string }
> = {
  [Agent.status.PENDING]: { label: 'Pending', className: 'bg-gray-100 text-gray-700' },
  [Agent.status.STARTING]: { label: 'Starting', className: 'bg-blue-100 text-blue-700' },
  [Agent.status.RUNNING]: { label: 'Running', className: 'bg-green-100 text-green-700 animate-pulse' },
  [Agent.status.COMMITTING]: { label: 'Committing', className: 'bg-yellow-100 text-yellow-700' },
  [Agent.status.DONE]: { label: 'Done', className: 'bg-emerald-100 text-emerald-700' },
  [Agent.status.FAILED]: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  [Agent.status.DELETED]: { label: 'Deleted', className: 'bg-gray-100 text-gray-500' },
};

interface Props {
  status: Agent.status;
}

export function AgentStatusBadge({ status }: Props) {
  const config = statusConfig[status] ?? { label: status, className: 'bg-gray-100 text-gray-700' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}
