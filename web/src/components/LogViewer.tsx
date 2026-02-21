import { useEffect, useRef, useState } from 'react';
import { Agent } from '../api';

interface Props {
  agent: Agent;
}

export function LogViewer({ agent }: Props) {
  const [lines, setLines] = useState<string[]>(() =>
    agent.logTail ? agent.logTail.split('\n') : [],
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const isLive = agent.status === Agent.status.RUNNING
    || agent.status === Agent.status.STARTING
    || agent.status === Agent.status.COMMITTING;

  useEffect(() => {
    if (!isLive) return;

    const url = `/api/projects/${agent.projectId}/agents/${agent.id}/logs`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      const text = e.data as string;
      setLines((prev) => [...prev, ...text.split('\n')]);
    };

    es.addEventListener('done', () => {
      es.close();
    });

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  }, [agent.id, agent.projectId, isLive]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="bg-gray-950 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800">
        <span className="text-xs font-mono text-gray-400">
          {isLive ? '● Live' : 'Log output'}
        </span>
        {isLive && (
          <span className="text-xs text-green-400 animate-pulse">streaming</span>
        )}
      </div>
      <div className="h-96 overflow-y-auto p-4 font-mono text-sm text-gray-200">
        {lines.length === 0 ? (
          <span className="text-gray-500 italic">No output yet...</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="leading-relaxed whitespace-pre-wrap break-all">
              {line || '\u00a0'}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
