import { useState, useEffect } from 'react';
import type { AgentType, CreateAgentRequest } from '../api';
import { CreateAgentRequest as CAR } from '../api';
import { api } from '../stores/apiClient';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (req: CreateAgentRequest) => Promise<void>;
}

export function CreateAgentDialog({ open, onClose, onSubmit }: Props) {
  const [prompt, setPrompt] = useState('');
  const [aiProvider, setAiProvider] = useState<CAR.aiProvider>(CAR.aiProvider.CLAUDE);
  const [sandboxTemplate, setSandboxTemplate] = useState('');
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      api.default.listAgentTypes().then(setAgentTypes).catch(() => {});
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      setError('Prompt is required');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit({
        prompt: prompt.trim(),
        aiProvider,
        sandboxTemplate: sandboxTemplate || undefined,
      });
      setPrompt('');
      setSandboxTemplate('');
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Set default template when provider changes
  const handleProviderChange = (p: CAR.aiProvider) => {
    setAiProvider(p);
    const type = agentTypes.find((t) => t.id === p);
    setSandboxTemplate(type?.sandboxTemplate ?? '');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-lg w-full mx-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Agent</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe what you want the agent to do..."
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              AI Provider
            </label>
            <select
              value={aiProvider}
              onChange={(e) => handleProviderChange(e.target.value as CAR.aiProvider)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.values(CAR.aiProvider).map((p) => (
                <option key={p} value={p}>
                  {agentTypes.find((t) => t.id === p)?.name ?? p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Sandbox Template <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={sandboxTemplate}
              onChange={(e) => setSandboxTemplate(e.target.value)}
              placeholder="docker/sandbox-templates:claude-code"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
