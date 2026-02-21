import { useState } from 'react';
import { api } from '../stores/apiClient';

interface Props {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
}

const isLocalhost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
  window.location.hostname,
);

export function FolderPicker({ value, onChange, placeholder }: Props) {
  const [picking, setPicking] = useState(false);

  const handleBrowse = async () => {
    setPicking(true);
    try {
      const result = await api.default.pickFolder();
      if (result.path) {
        onChange(result.path);
      }
    } catch {
      // ignore - user cancelled or not available
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '/path/to/project'}
        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {isLocalhost && (
        <button
          type="button"
          onClick={handleBrowse}
          disabled={picking}
          className="px-3 py-2 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {picking ? '…' : 'Browse…'}
        </button>
      )}
    </div>
  );
}
