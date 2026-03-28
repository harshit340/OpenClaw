import { useState, useCallback } from "react";

export default function ConfigImport({ onImported }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);

  const importConfig = async (config) => {
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("http://127.0.0.1:8891/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        onImported();
      } else {
        setError(data.error || "Import failed");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleFile = useCallback(async (file) => {
    try {
      const text = await file.text();
      const config = JSON.parse(text);
      await importConfig(config);
    } catch {
      setError("Invalid JSON file");
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handlePickFile = async () => {
    if (window.electronAPI?.pickFile) {
      const config = await window.electronAPI.pickFile();
      if (config) await importConfig(config);
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
      };
      input.click();
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-white">
      <div className="text-center max-w-md mx-auto px-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Bolofy</h1>
        <p className="text-gray-500 mb-8">Import your agent configuration to get started</p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-12 transition-colors ${
            dragging ? "border-black bg-gray-50" : "border-gray-300"
          }`}
        >
          <div className="mb-4">
            <svg className="w-12 h-12 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Drag & drop your <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">config.json</code> here
          </p>
          <button
            onClick={handlePickFile}
            disabled={importing}
            className="px-6 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {importing ? "Importing..." : "Browse Files"}
          </button>
        </div>

        {error && (
          <p className="mt-4 text-sm text-red-600">{error}</p>
        )}

        <p className="mt-6 text-xs text-gray-400">
          Download your config from the Bolofy dashboard
        </p>
      </div>
    </div>
  );
}
