import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Project } from '../api';
import { useProjectStore } from '../stores/projectStore';

interface Props {
  currentProjectId?: string;
}

export function ProjectPicker({ currentProjectId }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { projects, fetchProjects } = useProjectStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const currentProject = projects.find((p) => p.id === currentProjectId);

  const handleSelect = (project: Project) => {
    setOpen(false);
    router.navigate({ to: '/$projectId', params: { projectId: project.id } });
  };

  const handleNewProject = () => {
    setOpen(false);
    router.navigate({ to: '/new-project' });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 max-w-48 truncate cursor-pointer"
      >
        <span className="truncate">
          {currentProject?.name ?? 'Select project'}
        </span>
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="py-1 max-h-64 overflow-y-auto">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => handleSelect(project)}
                className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 cursor-pointer ${
                  project.id === currentProjectId ? 'font-medium text-blue-600' : 'text-gray-700'
                }`}
              >
                <div className="font-medium truncate">{project.name}</div>
                <div className="text-xs text-gray-400 truncate">{project.path}</div>
              </button>
            ))}
          </div>
          <div className="border-t border-gray-100 py-1">
            <button
              onClick={handleNewProject}
              className="w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 font-medium cursor-pointer"
            >
              + New project…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
