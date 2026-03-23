import SkillsModal from "./SkillsModal";
import { useState } from "react";
export default function Header({ config, onToggleSidebar }) {
  const [skillsOpen, setSkillsOpen] = useState(false);
  return (
    <header className="h-14 border-b border-gray-200 bg-white flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <div>
          <h1 className="text-sm font-semibold text-gray-900">{config.name}</h1>
          <p className="text-xs text-gray-500">{config.model}</p>
        </div>
        <div>
          <button
            onClick={() => setSkillsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            title="Manage Skills"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Skills
          </button>

          <SkillsModal isOpen={skillsOpen} onClose={() => setSkillsOpen(false)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-xs text-gray-500">Connected</span>
      </div>
    </header>
  );
}
