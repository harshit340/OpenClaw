import { useState, useEffect, useRef } from "react";
import Header from "./Header";
import Sidebar from "./Sidebar";
import MessageBubble from "./MessageBubble";
import InputBar from "./InputBar";
import useChat from "../hooks/useChat";

export default function ChatWindow({ config }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState(() => crypto.randomUUID()); // ✅
  const [sessions, setSessions] = useState([{ id: 1, title: "New Chat", sessionId: activeSessionId }]);
  const [activeSession, setActiveSession] = useState(1);
  const [sessionMessages, setSessionMessages] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const { messages, isStreaming, sendMessage, stopStreaming, clearMessages, loadMessages } =
    useChat(activeSessionId); // ✅ pass it in

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.role === "user");
      if (firstUserMsg) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeSession
              ? { ...s, title: firstUserMsg.content.slice(0, 40) }
              : s
          )
        );
      }
    }
  }, [messages, activeSession]);

  const handleNewChat = () => {
    setSessionMessages((prev) => ({ ...prev, [activeSession]: messages }));
    const newId = Date.now();
    const newSessionId = crypto.randomUUID(); // ✅ fresh session for OpenClaw
    setSessions((prev) => [{ id: newId, title: "New Chat", sessionId: newSessionId }, ...prev]);
    setActiveSession(newId);
    setActiveSessionId(newSessionId); // ✅ triggers useChat to use new session
    clearMessages();
  };

  const handleSelectSession = (id) => {
    setSessionMessages((prev) => ({ ...prev, [activeSession]: messages }));
    setActiveSession(id);
    const session = sessions.find((s) => s.id === id);
    setActiveSessionId(session?.sessionId || crypto.randomUUID()); // ✅ restore session
    const saved = sessionMessages[id];
    if (saved) loadMessages(saved);
    else clearMessages();
  };

  const handleSelectHistory = async (session) => {
    setSessionMessages((prev) => ({ ...prev, [activeSession]: messages }));
    setHistoryLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:8891/api/openclaw/sessions/${encodeURIComponent(session.key)}/history`);
      const data = await res.json();
      if (data.ok && data.messages) {
        loadMessages(data.messages);
      } else {
        loadMessages([{ role: "assistant", content: "Failed to load session history." }]);
      }
    } catch {
      loadMessages([{ role: "assistant", content: "Error loading session history." }]);
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white">
      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        onSelect={handleSelectSession}
        onNew={handleNewChat}
        isOpen={sidebarOpen}
        onSelectHistory={handleSelectHistory}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header config={config} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="max-w-3xl mx-auto">
            {historyLoading ? (
              <div className="flex items-center justify-center h-full min-h-[400px]">
                <div className="text-sm text-gray-500">Loading session history...</div>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center h-full min-h-[400px]">
                <div className="text-center">
                  <h2 className="text-xl font-semibold text-gray-900 mb-2">{config.name}</h2>
                  <p className="text-sm text-gray-500">{config.description || "Ask me anything"}</p>
                </div>
              </div>
            ) : (
              messages.map((msg, i) => <MessageBubble key={i} message={msg} />)
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
        <InputBar onSend={sendMessage} isStreaming={isStreaming} onStop={stopStreaming} />
      </div>
    </div>
  );
}