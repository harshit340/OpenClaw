import { useState, useEffect } from "react";

export default function ConnectionTest({ config, onSuccess }) {
  const [status, setStatus] = useState("testing"); // testing | success | failed
  const [gatewayStatus, setGatewayStatus] = useState(null); // null | testing | starting | pass | fail
  const [chatStatus, setChatStatus] = useState(null);
  const [error, setError] = useState(null);
  const [statusText, setStatusText] = useState("Testing connection...");

  const startGateway = async () => {
    setGatewayStatus("starting");
    setStatusText("Starting OpenClaw gateway...");
    setError(null);

    try {
      const res = await fetch("/api/openclaw/start", { method: "POST" });
      const data = await res.json();

      if (data.status === "started" || data.status === "already_running") {
        setGatewayStatus("pass");
        return true;
      } else {
        setGatewayStatus("fail");
        setError(data.error || "Failed to start gateway");
        return false;
      }
    } catch (err) {
      setGatewayStatus("fail");
      setError(err.message);
      return false;
    }
  };

  const runTests = async () => {
    setStatus("testing");
    setGatewayStatus("testing");
    setChatStatus(null);
    setError(null);
    setStatusText("Checking OpenClaw gateway...");

    // Test 1: Gateway connectivity
    let gatewayOk = false;
    try {
      const res = await fetch("/api/openclaw/health");
      const data = await res.json();
      if (data.status === "ok") {
        setGatewayStatus("pass");
        gatewayOk = true;
      }
    } catch {}

    // If gateway is down, try to start it automatically
    if (!gatewayOk) {
      gatewayOk = await startGateway();
    }

    if (!gatewayOk) {
      setStatus("failed");
      setStatusText("Connection failed");
      return;
    }

    // Test 2: Check OpenClaw CLI is available
    setStatusText("Checking OpenClaw CLI...");
    setChatStatus("testing");
    try {
      const res = await fetch("/api/openclaw/cli-check");
      const data = await res.json();
      if (data.status === "ok") {
        setChatStatus("pass");
        setStatus("success");
        setStatusText("All checks passed");
      } else {
        setChatStatus("fail");
        setError("OpenClaw CLI not found. Install it first.");
        setStatus("failed");
        setStatusText("Connection failed");
      }
    } catch (err) {
      setChatStatus("fail");
      setError(err.message);
      setStatus("failed");
      setStatusText("Connection failed");
    }
  };

  useEffect(() => {
    runTests();
  }, []);

  const StatusIcon = ({ state }) => {
    if (state === "pass") {
      return (
        <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      );
    }
    if (state === "fail") {
      return (
        <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    }
    if (state === "testing" || state === "starting") {
      return <div className="w-5 h-5 border-2 border-gray-300 border-t-black rounded-full animate-spin shrink-0" />;
    }
    return <div className="w-5 h-5 rounded-full border-2 border-gray-200 shrink-0" />;
  };

  const gatewayLabel = () => {
    if (gatewayStatus === "starting") return "Starting OpenClaw gateway...";
    if (gatewayStatus === "testing") return "Checking gateway connectivity";
    if (gatewayStatus === "pass") return "Gateway connected";
    if (gatewayStatus === "fail") return "Gateway unreachable";
    return "Checking gateway connectivity";
  };

  const chatLabel = () => {
    if (chatStatus === "testing") return "Checking CLI availability...";
    if (chatStatus === "pass") return "OpenClaw CLI ready";
    if (chatStatus === "fail") return "OpenClaw CLI not found";
    return "Waiting to check CLI";
  };

  return (
    <div className="flex items-center justify-center h-screen bg-white">
      <div className="text-center max-w-md mx-auto px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">{config.name}</h1>
        <p className="text-sm text-gray-500 mb-8">{statusText}</p>

        <div className="bg-gray-50 rounded-2xl p-6 text-left space-y-4">
          <div className="flex items-center gap-3">
            <StatusIcon state={gatewayStatus} />
            <div>
              <p className="text-sm font-medium text-gray-900">OpenClaw Gateway</p>
              <p className="text-xs text-gray-500">{gatewayLabel()}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <StatusIcon state={chatStatus} />
            <div>
              <p className="text-sm font-medium text-gray-900">OpenClaw CLI</p>
              <p className="text-xs text-gray-500">{chatLabel()}</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="mt-6 flex gap-3 justify-center">
          {status === "success" && (
            <button
              onClick={onSuccess}
              className="px-6 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
            >
              Start Chatting
            </button>
          )}
          {status === "failed" && (
            <button
              onClick={runTests}
              className="px-6 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
            >
              Retry
            </button>
          )}
        </div>

        {status === "success" && (
          <p className="mt-4 text-xs text-green-600 font-medium">All checks passed</p>
        )}
      </div>
    </div>
  );
}
