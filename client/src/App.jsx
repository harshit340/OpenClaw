import { useState, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import ConfigImport from "./components/ConfigImport";
import ConnectionTest from "./components/ConnectionTest";

export default function App() {
  const [config, setConfig] = useState(null);
  const [step, setStep] = useState("loading"); // loading | import | test | chat

  const fetchConfig = async () => {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      if (data.loaded) {
        setConfig(data);
        setStep("test");
      } else {
        setStep("import");
      }
    } catch (err) {
      console.error("Failed to fetch config:", err);
      setStep("import");
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleConfigImported = () => {
    fetchConfig();
  };

  const handleTestSuccess = () => {
    setStep("chat");
  };

  if (step === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <div className="w-8 h-8 border-3 border-gray-300 border-t-black rounded-full animate-spin" />
      </div>
    );
  }

  if (step === "import") {
    return <ConfigImport onImported={handleConfigImported} />;
  }

  if (step === "test") {
    return <ConnectionTest config={config} onSuccess={handleTestSuccess} />;
  }

  return <ChatWindow config={config} />;
}
