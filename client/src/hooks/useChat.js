import { useState, useCallback, useRef, useEffect } from "react";

export default function useChat(sessionId) {  
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const sessionIdRef = useRef(sessionId || crypto.randomUUID()); // ✅ use it here
  const abortRef = useRef(null);

  useEffect(() => {
    if (sessionId) sessionIdRef.current = sessionId;
  }, [sessionId]);

  const sendMessage = useCallback(async (text) => {
    const userMsg = { role: "user", content: text };
    const assistantMsg = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("http://127.0.0.1:8891/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, sessionId: sessionIdRef.current }), // ✅
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: `Error: ${parsed.error}` };
                return updated;
              });
              break;
            }
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, content: last.content + delta.content };
                return updated;
              });
            }
          } catch { }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${err.message}` };
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [messages]);

  const stopStreaming = useCallback(() => { abortRef.current?.abort(); }, []);
  const clearMessages = useCallback(() => { setMessages([]); }, []);
  const loadMessages = useCallback((msgs) => { setMessages(msgs); }, []);

  return { messages, isStreaming, sendMessage, stopStreaming, clearMessages, loadMessages };
}