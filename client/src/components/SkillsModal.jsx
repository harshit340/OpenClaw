import { useState, useEffect, useRef } from "react";

export default function SkillsModal({ isOpen, onClose }) {
  // --- Installed Skills Tab ---
  const [search, setSearch] = useState("");
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  const [filter, setFilter] = useState("all");

  // --- ClawHub Search Tab ---
  const [activeTab, setActiveTab] = useState("installed"); // "installed" | "discover"
  const [hubSearch, setHubSearch] = useState("");
  const [hubResults, setHubResults] = useState([]);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubSearched, setHubSearched] = useState(false);
  const [installingSkill, setInstallingSkill] = useState({});
  const [updatingSkill, setUpdatingSkill] = useState({});

  const [toast, setToast] = useState(null);
  const searchRef = useRef(null);
  const hubSearchRef = useRef(null);
  const hubDebounceRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      fetchSkills();
      setTimeout(() => searchRef.current?.focus(), 100);
    } else {
      setSearch("");
      setFilter("all");
      setActiveTab("installed");
      setHubSearch("");
      setHubResults([]);
      setHubSearched(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (activeTab === "discover") {
      setTimeout(() => hubSearchRef.current?.focus(), 100);
    }
  }, [activeTab]);

  // Auto-search ClawHub as user types (debounced)
  useEffect(() => {
    if (activeTab !== "discover") return;
    if (hubDebounceRef.current) clearTimeout(hubDebounceRef.current);
    if (!hubSearch.trim()) {
      setHubResults([]);
      setHubSearched(false);
      return;
    }
    hubDebounceRef.current = setTimeout(() => {
      searchClawHub(hubSearch.trim());
    }, 400);
    return () => clearTimeout(hubDebounceRef.current);
  }, [hubSearch, activeTab]);

  const fetchSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch("http://127.0.0.1:8891/api/skills");
      const data = await res.json();
      if (data.ok) setSkills(data.skills || []);
      else showToast("Failed to load skills", "error");
    } catch {
      showToast("Failed to load skills", "error");
    } finally {
      setLoading(false);
    }
  };

  const searchClawHub = async (query) => {
    setHubLoading(true);
    setHubSearched(false);
    try {
      const res = await fetch(`http://127.0.0.1:8891/api/skills/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.ok) {
        setHubResults(data.results || []);
      } else if (data.notInstalled) {
        showToast("clawhub CLI not installed. Run: npm install -g clawhub", "error");
        setHubResults([]);
      } else {
        showToast(data.error || "Search failed", "error");
        setHubResults([]);
      }
    } catch {
      showToast("Search failed", "error");
      setHubResults([]);
    } finally {
      setHubLoading(false);
      setHubSearched(true);
    }
  };

  const handleInstall = async (skillSlug) => {
    setInstallingSkill(prev => ({ ...prev, [skillSlug]: true }));
    try {
      const res = await fetch("http://127.0.0.1:8891/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName: skillSlug }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`"${skillSlug}" installed! Refresh to see it.`);
        // Refresh installed skills list
        await fetchSkills();
      } else {
        showToast(data.error || "Install failed", "error");
      }
    } catch {
      showToast("Install failed", "error");
    } finally {
      setInstallingSkill(prev => ({ ...prev, [skillSlug]: false }));
    }
  };

  const handleUpdate = async (skillName) => {
    setUpdatingSkill(prev => ({ ...prev, [skillName]: true }));
    try {
      const res = await fetch("http://127.0.0.1:8891/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`"${skillName}" updated!`);
      } else {
        showToast(data.error || "Update failed", "error");
      }
    } catch {
      showToast("Update failed", "error");
    } finally {
      setUpdatingSkill(prev => ({ ...prev, [skillName]: false }));
    }
  };

  const showToast = (message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleToggle = async (skill) => {
    const endpoint = skill.disabled ? "http://127.0.0.1:8891/api/skills/enable" : "http://127.0.0.1:8891/api/skills/disable";
    const action = skill.disabled ? "enabling" : "disabling";
    setActionLoading(prev => ({ ...prev, [skill.name]: action }));
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName: skill.name }),
      });
      const data = await res.json();
      if (data.ok) {
        setSkills(prev => prev.map(s =>
          s.name === skill.name ? { ...s, disabled: !s.disabled } : s
        ));
        showToast(`"${skill.name}" ${skill.disabled ? "enabled" : "disabled"}`);
      } else {
        showToast(data.error || "Failed", "error");
      }
    } catch {
      showToast("Request failed", "error");
    } finally {
      setActionLoading(prev => ({ ...prev, [skill.name]: null }));
    }
  };

  const installedNames = new Set(skills.map(s => s.name));

  const filtered = skills.filter(s => {
    const q = search.toLowerCase();
    const matchesSearch = !q ||
      s.name.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q);
    const matchesFilter =
      filter === "all" ||
      (filter === "eligible" && s.eligible) ||
      (filter === "enabled" && !s.disabled);
    return matchesSearch && matchesFilter;
  });

  const counts = {
    all: skills.length,
    eligible: skills.filter(s => s.eligible).length,
    enabled: skills.filter(s => !s.disabled).length,
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden"
        style={{ maxHeight: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Agent Skills</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {counts.enabled} enabled · {counts.eligible} ready · {counts.all} installed
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-5 gap-1 pb-3 border-b border-gray-100">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeTab === "installed"
                ? "bg-black text-white"
                : "text-gray-500 hover:bg-gray-100"
              }`}
          >
            Installed
          </button>
          <button
            onClick={() => setActiveTab("discover")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${activeTab === "discover"
                ? "bg-black text-white"
                : "text-gray-500 hover:bg-gray-100"
              }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Discover
          </button>
        </div>

        {/* ── INSTALLED TAB ── */}
        {activeTab === "installed" && (
          <>
            <div className="px-5 py-3 space-y-2.5">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search installed skills..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
                />
              </div>
              <div className="flex gap-1.5">
                {[
                  { key: "all", label: "All" },
                  { key: "eligible", label: "Ready" },
                  { key: "enabled", label: "Enabled" },
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${filter === f.key
                        ? "bg-black text-white"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}
                  >
                    {f.label} <span className="opacity-60 ml-0.5">{counts[f.key]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-5 h-5 border-2 border-gray-200 border-t-black rounded-full animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-sm text-gray-400">No skills found</p>
                  <button
                    onClick={() => setActiveTab("discover")}
                    className="mt-3 text-xs text-black underline underline-offset-2"
                  >
                    Discover skills on ClawHub →
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  {filtered.map(skill => {
                    const isEnabled = !skill.disabled;
                    const action = actionLoading[skill.name];
                    const isUpdating = updatingSkill[skill.name];
                    const missingBins = skill.missing?.bins || [];
                    const missingEnvs = skill.missing?.env || [];
                    const missingOs = skill.missing?.os || [];
                    const hasRequirements = missingBins.length > 0 || missingEnvs.length > 0 || missingOs.length > 0;

                    return (
                      <div key={skill.name}
                        className="flex items-start gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 mt-0.5 ${skill.eligible ? "bg-gray-100" : "bg-gray-50"
                          }`}>
                          {skill.emoji}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-gray-900">{skill.name}</span>
                            {skill.eligible && (
                              <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full font-medium">ready</span>
                            )}
                            {isEnabled && (
                              <span className="text-xs bg-black text-white px-1.5 py-0.5 rounded-full font-medium">on</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2 leading-relaxed">
                            {skill.description}
                          </p>
                          {hasRequirements && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {missingBins.map(b => (
                                <span key={b} className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-mono">{b}</span>
                              ))}
                              {missingEnvs.map(e => (
                                <span key={e} className="text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-mono">{e}</span>
                              ))}
                              {missingOs.length > 0 && (
                                <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{missingOs.join(", ")} only</span>
                              )}
                            </div>
                          )}
                        </div>

                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-400">Changes apply to new conversations</p>
              <button
                onClick={fetchSkills}
                disabled={loading}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </>
        )}

        {/* ── DISCOVER TAB ── */}
        {activeTab === "discover" && (
          <>
            <div className="px-5 py-3">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={hubSearchRef}
                  type="text"
                  placeholder="Search ClawHub... e.g. calendar, github, notion"
                  value={hubSearch}
                  onChange={e => setHubSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
                />
                {hubLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="w-4 h-4 border-2 border-gray-200 border-t-black rounded-full animate-spin" />
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Search and install skills from{" "}
                <a href="https://clawhub.com" target="_blank" rel="noreferrer"
                  className="underline underline-offset-2 hover:text-gray-600">
                  ClawHub
                </a>{" "}
                directly into OpenClaw
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {/* Empty state */}
              {!hubSearch && !hubLoading && (
                <div className="text-center py-12 px-4">
                  <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-gray-700">Search ClawHub</p>
                  <p className="text-xs text-gray-400 mt-1">Type above to find and install new skills</p>
                  <div className="flex flex-wrap gap-1.5 justify-center mt-4">
                    {["github", "notion", "calendar", "slack", "spotify", "weather"].map(tag => (
                      <button
                        key={tag}
                        onClick={() => setHubSearch(tag)}
                        className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs rounded-full transition-colors"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Loading */}
              {hubLoading && (
                <div className="flex items-center justify-center py-16">
                  <div className="w-5 h-5 border-2 border-gray-200 border-t-black rounded-full animate-spin" />
                </div>
              )}

              {/* No results */}
              {!hubLoading && hubSearched && hubResults.length === 0 && (
                <div className="text-center py-12">
                  <p className="text-sm text-gray-400">No skills found for "{hubSearch}"</p>
                  <p className="text-xs text-gray-300 mt-1">Try a different search term</p>
                </div>
              )}

              {/* Results */}
              {!hubLoading && hubResults.length > 0 && (
                <div className="space-y-1">
                  {hubResults.map(skill => {
                    const slug = skill.slug || skill.name;
                    const isInstalled = installedNames.has(slug) || installedNames.has(skill.name);
                    const isInstalling = installingSkill[slug];

                    return (
                      <div key={slug}
                        className="flex items-start gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors">
                        <div className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center text-lg shrink-0 mt-0.5">
                          {skill.emoji || "🔧"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-gray-900">{skill.name || slug}</span>
                            {isInstalled && (
                              <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded-full font-medium">installed</span>
                            )}
                            {skill.version && (
                              <span className="text-xs text-gray-300 font-mono">v{skill.version}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2 leading-relaxed">
                            {skill.description}
                          </p>
                          {skill.author && (
                            <p className="text-xs text-gray-300 mt-0.5">by {skill.author}</p>
                          )}
                        </div>
                        <button
                          onClick={() => !isInstalled && handleInstall(slug)}
                          disabled={!!isInstalling || isInstalled}
                          className={`shrink-0 mt-0.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${isInstalled
                              ? "bg-gray-100 text-gray-400 cursor-default"
                              : isInstalling
                                ? "bg-gray-100 text-gray-400"
                                : "bg-black text-white hover:bg-gray-800 active:scale-95"
                            }`}
                        >
                          {isInstalling ? (
                            <>
                              <div className="w-3 h-3 border border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                              Installing
                            </>
                          ) : isInstalled ? (
                            <>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                              Installed
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                              </svg>
                              Install
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-400">
                Installs into your active OpenClaw workspace
              </p>
              <a
                href="https://clawhub.com"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Browse all →
              </a>
            </div>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg z-60 whitespace-nowrap ${toast.type === "error" ? "bg-red-500 text-white" : "bg-gray-900 text-white"
          }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}