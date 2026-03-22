import { useState, useEffect } from "react";

export default function Sidebar({ sessions, activeSession, onSelect, onNew, isOpen, onSelectHistory }) {
  const [historySessions, setHistorySessions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeHistoryKey, setActiveHistoryKey] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setHistoryLoading(true);
    fetch("/api/openclaw/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.sessions) {
          setHistorySessions(data.sessions);
        }
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleHistoryClick = (session) => {
    setActiveHistoryKey(session.key);
    if (onSelectHistory) {
      onSelectHistory(session);
    }
  };

  const handleNewChat = () => {
    setActiveHistoryKey(null);
    onNew();
  };

  const handleSelectSession = (id) => {
    setActiveHistoryKey(null);
    onSelect(id);
  };

  const formatTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
  };

  const sessionTitle = (s) => {
    // Use the short part of the key after "agent:main:"
    const shortKey = s.key.replace(/^agent:\w+:/, "");
    return shortKey.length > 24 ? shortKey.slice(0, 24) + "..." : shortKey;
  };

  return (
    <aside className="w-64 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0">
      <div className="p-3 border-b border-gray-200">
        <button
          onClick={handleNewChat}
          className="w-full py-2 px-3 text-sm font-medium bg-black text-white rounded-lg hover:bg-gray-800 transition-colors"
        >
          + New Chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => handleSelectSession(session.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate ${
              activeSession === session.id && !activeHistoryKey
                ? "bg-gray-200 text-gray-900 font-medium"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {session.title || "New Chat"}
          </button>
        ))}

        {/* OpenClaw History Section */}
        <div className="mt-4 pt-3 border-t border-gray-200">
          <div className="px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            History
          </div>
          {historyLoading && (
            <div className="px-3 py-2 text-xs text-gray-400">Loading...</div>
          )}
          {historySessions.map((s) => (
            <button
              key={s.key}
              onClick={() => handleHistoryClick(s)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate ${
                activeHistoryKey === s.key
                  ? "bg-gray-200 text-gray-900 font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
              title={s.key}
            >
              <div className="truncate">{sessionTitle(s)}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {formatTime(s.updatedAt)} {s.model ? `· ${s.model}` : ""}
              </div>
            </button>
          ))}
          {!historyLoading && historySessions.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No sessions found</div>
          )}
        </div>
      </div>
      <div className="p-3 border-t border-gray-200">
        <div className="text-xs text-gray-400 text-center">Bolofy Agent</div>
      </div>
    </aside>
  );
}
