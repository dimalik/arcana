"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  Search,
  Sparkles,
  GraduationCap,
  Building,
  FlaskConical,
  BookOpen,
  Plus,
  X,
  UserSearch,
} from "lucide-react";
import { toast } from "sonner";

// ── Constants ────────────────────────────────────────────────────

const ROLES = [
  { value: "phd_student", label: "PhD Student", icon: GraduationCap },
  { value: "postdoc", label: "Postdoc", icon: FlaskConical },
  { value: "professor", label: "Professor", icon: BookOpen },
  { value: "industry_researcher", label: "Industry Researcher", icon: Building },
  { value: "engineer", label: "Engineer", icon: Building },
  { value: "student", label: "Student", icon: GraduationCap },
] as const;

const EXPERTISE_LEVELS = [
  { value: "beginner", label: "Getting started", desc: "New to research or this field" },
  { value: "intermediate", label: "Comfortable", desc: "Can read papers independently" },
  { value: "expert", label: "Expert", desc: "Deep domain knowledge" },
] as const;

const REVIEW_FOCUSES = [
  { value: "methodology", label: "Methodology" },
  { value: "novelty", label: "Novelty" },
  { value: "applications", label: "Applications" },
  { value: "reproducibility", label: "Reproducibility" },
  { value: "theoretical_rigor", label: "Theoretical Rigor" },
  { value: "clinical_relevance", label: "Clinical Relevance" },
] as const;

const DOMAIN_SUGGESTIONS = [
  "natural-language-processing", "computer-vision", "reinforcement-learning",
  "generative-models", "graph-neural-networks", "robotics",
  "medical-imaging", "speech-processing", "information-retrieval",
  "recommender-systems", "neuroscience", "bioinformatics",
  "quantum-computing", "climate-science", "materials-science",
  "drug-discovery", "autonomous-driving", "multimodal-learning",
];

// ── Types ────────────────────────────────────────────────────────

interface AuthorResult {
  authorId: string;
  name: string;
  affiliations: string[];
  paperCount: number;
  citationCount: number;
  hIndex: number;
  url: string | null;
}

interface SeedPaper {
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  citationCount: number | null;
  abstract: string | null;
  externalUrl: string;
  semanticScholarId: string;
  selected: boolean;
}

// ── Paper list component (shared between author and topic seeds) ──

function PaperList({
  papers,
  onToggle,
  onToggleAll,
  selectedCount,
}: {
  papers: SeedPaper[];
  onToggle: (i: number) => void;
  onToggleAll: () => void;
  selectedCount: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {papers.length} papers found — {selectedCount} selected
        </p>
        <Button size="sm" variant="ghost" onClick={onToggleAll}>
          {selectedCount === papers.length ? "Deselect all" : "Select all"}
        </Button>
      </div>
      <div className="max-h-80 overflow-y-auto space-y-1.5 rounded-lg border p-2">
        {papers.map((paper, i) => (
          <button
            key={i}
            onClick={() => onToggle(i)}
            className={`flex items-start gap-3 w-full text-left rounded-md px-3 py-2.5 transition-colors ${
              paper.selected ? "bg-foreground/5" : "opacity-50 hover:opacity-75"
            }`}
          >
            <span
              className={`mt-0.5 shrink-0 flex h-4 w-4 items-center justify-center rounded border ${
                paper.selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-muted-foreground/30"
              }`}
            >
              {paper.selected && <Check className="h-3 w-3" />}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-tight line-clamp-2">
                {paper.title}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {paper.authors.slice(0, 3).join(", ")}
                {paper.authors.length > 3 && " et al."}
                {paper.year && ` · ${paper.year}`}
                {paper.venue && ` · ${paper.venue}`}
                {paper.citationCount != null && ` · ${paper.citationCount} citations`}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [completing, setCompleting] = useState(false);

  // Step 0: Identity
  const [name, setName] = useState("");
  const [researchRole, setResearchRole] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [expertiseLevel, setExpertiseLevel] = useState("");
  const [reviewFocus, setReviewFocus] = useState<string[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);

  // Author identification
  const [authorSearching, setAuthorSearching] = useState(false);
  const [authorResults, setAuthorResults] = useState<AuthorResult[]>([]);
  const [selectedAuthor, setSelectedAuthor] = useState<AuthorResult | null>(null);
  const [authorSearchDone, setAuthorSearchDone] = useState(false);

  // Step 1: Seed library
  const [seedMode, setSeedMode] = useState<"author" | "topics" | "skip" | null>(null);
  const [topicInput, setTopicInput] = useState("");
  const [searchTopics, setSearchTopics] = useState<string[]>([]);
  const [seedPapers, setSeedPapers] = useState<SeedPaper[]>([]);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);

  // Load existing data
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          if (data.onboardingCompleted) {
            router.replace("/");
            return;
          }
          if (data.name) setName(data.name);
          if (data.researchRole) setResearchRole(data.researchRole);
          if (data.affiliation) setAffiliation(data.affiliation);
          if (data.domains?.length) setDomains(data.domains);
          if (data.expertiseLevel) setExpertiseLevel(data.expertiseLevel);
          if (data.reviewFocus?.length) setReviewFocus(data.reviewFocus);
        }
      })
      .catch(() => {});
  }, [router]);

  // ── Author search ──────────────────────────────────────────────

  const handleAuthorSearch = async () => {
    if (!name.trim()) return;
    setAuthorSearching(true);
    setAuthorResults([]);
    setSelectedAuthor(null);
    setAuthorSearchDone(false);
    try {
      const params = new URLSearchParams({ name: name.trim() });
      if (affiliation.trim()) params.set("affiliation", affiliation.trim());
      const res = await fetch(`/api/onboarding/author-search?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAuthorResults(data.authors || []);
      setAuthorSearchDone(true);
      if (data.authors?.length === 0) {
        toast.info("No matching profiles found");
      }
    } catch {
      toast.error("Author search failed");
    } finally {
      setAuthorSearching(false);
    }
  };

  const handleSelectAuthor = async (author: AuthorResult) => {
    // If clicking the same author, deselect
    if (selectedAuthor?.authorId === author.authorId) {
      setSelectedAuthor(null);
      return;
    }

    // Select and immediately proceed — save profile + jump to papers
    setSelectedAuthor(author);
    setSavingProfile(true);

    // Use the author's affiliation if we don't have one
    const bestAffiliation = affiliation.trim() || (author.affiliations[0] || "");

    try {
      const res = await fetch("/api/onboarding/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || author.name,
          affiliation: bestAffiliation || undefined,
          researchRole: researchRole || undefined,
          domains,
          expertiseLevel: expertiseLevel || undefined,
          reviewFocus,
        }),
      });
      if (!res.ok) throw new Error();

      // Jump straight to step 1 with their papers
      setStep(1);
      setSeedMode("author");
      fetchAuthorPapers(author.authorId);
    } catch {
      toast.error("Failed to save profile");
      setSelectedAuthor(null);
    } finally {
      setSavingProfile(false);
    }
  };

  const fetchAuthorPapers = async (authorId: string) => {
    setSearching(true);
    setSeedPapers([]);
    try {
      const res = await fetch("/api/onboarding/author-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorId }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const papers: SeedPaper[] = (data.papers || []).map((p: Omit<SeedPaper, "selected">) => ({
        ...p,
        selected: true,
      }));
      setSeedPapers(papers);
      if (papers.length === 0) {
        toast.info("No papers found for this author");
      }
    } catch {
      toast.error("Failed to fetch papers");
    } finally {
      setSearching(false);
    }
  };

  // ── Domain & focus helpers ────────────────────────────────────

  const addDomain = (d: string) => {
    const clean = d.trim().toLowerCase().replace(/\s+/g, "-");
    if (clean && !domains.includes(clean)) {
      setDomains([...domains, clean]);
    }
    setDomainInput("");
  };

  const removeDomain = (d: string) => setDomains(domains.filter((x) => x !== d));

  const toggleFocus = (f: string) => {
    setReviewFocus((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
    );
  };

  // ── Save & navigate ───────────────────────────────────────────

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await fetch("/api/onboarding/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          researchRole: researchRole || undefined,
          affiliation: affiliation.trim() || undefined,
          domains,
          expertiseLevel: expertiseLevel || undefined,
          reviewFocus,
        }),
      });
      if (!res.ok) throw new Error();
      setStep(1);
    } catch {
      toast.error("Failed to save profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleTopicSearch = useCallback(async () => {
    const topics = searchTopics.length > 0 ? searchTopics : domains.slice(0, 3);

    if (topics.length === 0) {
      toast.error("Add some topics or domains first");
      return;
    }

    setSearching(true);
    setSeedPapers([]);
    try {
      const res = await fetch("/api/onboarding/seed-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topics }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();

      const papers: SeedPaper[] = [];
      const seen = new Set<string>();
      for (const group of data.results) {
        for (const p of group.papers) {
          const key = p.doi || p.title.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          papers.push({ ...p, selected: true });
        }
      }
      setSeedPapers(papers);
      if (papers.length === 0) {
        toast.info("No papers found for those topics");
      }
    } catch {
      toast.error("Search failed");
    } finally {
      setSearching(false);
    }
  }, [searchTopics, domains]);

  const togglePaper = (idx: number) => {
    setSeedPapers((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], selected: !updated[idx].selected };
      return updated;
    });
  };

  const toggleAllPapers = () => {
    setSeedPapers((prev) => {
      const allSelected = prev.every((p) => p.selected);
      return prev.map((p) => ({ ...p, selected: !allSelected }));
    });
  };

  const importSelected = async () => {
    const selected = seedPapers.filter((p) => p.selected);
    if (selected.length === 0) {
      toast.error("Select at least one paper");
      return;
    }

    setImporting(true);
    try {
      const res = await fetch("/api/onboarding/import-seeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ papers: selected }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      toast.success(`Imported ${data.imported} paper${data.imported !== 1 ? "s" : ""}`);
      setStep(2);
    } catch {
      toast.error("Import failed");
    } finally {
      setImporting(false);
    }
  };

  const completeOnboarding = async () => {
    setCompleting(true);
    try {
      await fetch("/api/onboarding/complete", { method: "POST" });
      router.replace("/");
      router.refresh();
    } catch {
      toast.error("Something went wrong");
    } finally {
      setCompleting(false);
    }
  };

  const selectedCount = seedPapers.filter((p) => p.selected).length;
  const canSearchAuthor = name.trim().length >= 2;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {["Your Profile", "Seed Library", "Ready"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                  i < step
                    ? "bg-emerald-600 text-white"
                    : i === step
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span className={`text-sm hidden sm:block ${i === step ? "font-medium" : "text-muted-foreground"}`}>
                {label}
              </span>
              {i < 2 && <div className="w-8 h-px bg-border" />}
            </div>
          ))}
        </div>

        {/* ── Step 0: Profile ──────────────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold tracking-tight">Welcome to Arcana</h1>
              <p className="text-muted-foreground mt-1">
                Tell us about yourself so we can personalize your experience
              </p>
            </div>

            <div className="space-y-5">
              {/* Name + Author search */}
              <div>
                <Label className="text-sm font-medium">Your name</Label>
                <div className="flex gap-2 mt-1.5">
                  <Input
                    value={name}
                    onChange={(e) => { setName(e.target.value); setAuthorSearchDone(false); setSelectedAuthor(null); }}
                    placeholder="Jane Smith"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAuthorSearch}
                    disabled={!canSearchAuthor || authorSearching}
                    title="Find your profile on Semantic Scholar"
                  >
                    {authorSearching ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserSearch className="h-4 w-4" />
                    )}
                    <span className="ml-1.5 hidden sm:inline">Find me</span>
                  </Button>
                </div>
              </div>

              {/* Author search results */}
              {authorSearchDone && authorResults.length > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Is this you? Click your profile to import your papers.
                  </p>
                  {authorResults.map((author) => (
                    <button
                      key={author.authorId}
                      onClick={() => handleSelectAuthor(author)}
                      disabled={savingProfile}
                      className="flex items-start gap-3 w-full text-left rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50 border border-transparent disabled:opacity-50"
                    >
                      <div className="mt-1 shrink-0 flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                        {author.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{author.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {author.affiliations.length > 0
                            ? author.affiliations.join(", ")
                            : "No affiliation listed"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {author.paperCount} papers · {author.citationCount.toLocaleString()} citations · h-index {author.hIndex}
                        </p>
                      </div>
                      <ArrowRight className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  <p className="text-xs text-muted-foreground text-center pt-1">
                    Not here? Fill in the rest below and continue manually.
                  </p>
                </div>
              )}

              {authorSearchDone && authorResults.length === 0 && (
                <p className="text-xs text-muted-foreground rounded-lg border border-dashed p-3 text-center">
                  No matching author profiles found on Semantic Scholar. You can still seed your library by topic in the next step.
                </p>
              )}

              {/* Role */}
              <div>
                <Label className="text-sm font-medium">Research role</Label>
                <div className="grid grid-cols-3 gap-2 mt-1.5">
                  {ROLES.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => setResearchRole(researchRole === value ? "" : value)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                        researchRole === value
                          ? "border-foreground bg-foreground/5 font-medium"
                          : "border-border hover:border-foreground/30"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Affiliation */}
              <div>
                <Label className="text-sm font-medium">Affiliation</Label>
                <Input
                  value={affiliation}
                  onChange={(e) => { setAffiliation(e.target.value); setAuthorSearchDone(false); setSelectedAuthor(null); }}
                  placeholder="MIT, Google Research, etc."
                  className="mt-1.5"
                />
              </div>

              {/* Research domains */}
              <div>
                <Label className="text-sm font-medium">Research domains</Label>
                <div className="flex gap-2 mt-1.5">
                  <Input
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDomain(domainInput);
                      }
                    }}
                    placeholder="e.g. natural-language-processing"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addDomain(domainInput)}
                    disabled={!domainInput.trim()}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {domains.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {domains.map((d) => (
                      <Badge key={d} variant="secondary" className="gap-1 pr-1">
                        {d}
                        <button onClick={() => removeDomain(d)} className="ml-0.5 hover:text-destructive">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                {domains.length === 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {DOMAIN_SUGGESTIONS.slice(0, 12).map((d) => (
                      <button
                        key={d}
                        onClick={() => addDomain(d)}
                        className="rounded-full border border-dashed border-muted-foreground/30 px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/50 hover:text-foreground transition-colors"
                      >
                        + {d}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Expertise level */}
              <div>
                <Label className="text-sm font-medium">Expertise level</Label>
                <div className="grid grid-cols-3 gap-2 mt-1.5">
                  {EXPERTISE_LEVELS.map(({ value, label, desc }) => (
                    <button
                      key={value}
                      onClick={() => setExpertiseLevel(expertiseLevel === value ? "" : value)}
                      className={`flex flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        expertiseLevel === value
                          ? "border-foreground bg-foreground/5"
                          : "border-border hover:border-foreground/30"
                      }`}
                    >
                      <span className={`text-sm ${expertiseLevel === value ? "font-medium" : ""}`}>{label}</span>
                      <span className="text-xs text-muted-foreground">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Review focus */}
              <div>
                <Label className="text-sm font-medium">What matters most in paper reviews?</Label>
                <p className="text-xs text-muted-foreground mb-1.5">Select all that apply</p>
                <div className="flex flex-wrap gap-2">
                  {REVIEW_FOCUSES.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => toggleFocus(value)}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        reviewFocus.includes(value)
                          ? "border-foreground bg-foreground/5 font-medium"
                          : "border-border hover:border-foreground/30"
                      }`}
                    >
                      {reviewFocus.includes(value) && <Check className="inline h-3 w-3 mr-1" />}
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button onClick={saveProfile} disabled={savingProfile}>
                {savingProfile ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="mr-1.5 h-4 w-4" />
                )}
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 1: Seed Library ─────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold tracking-tight">Seed Your Library</h1>
              <p className="text-muted-foreground mt-1">
                {seedMode === "author" && selectedAuthor
                  ? `Showing recent papers by ${selectedAuthor.name}`
                  : "Start with some papers so Arcana can learn your interests"}
              </p>
            </div>

            {/* Mode selector (only if not already auto-set to author) */}
            {!seedMode && (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  onClick={() => setSeedMode("topics")}
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 hover:border-foreground/30 hover:bg-muted/30 transition-colors"
                >
                  <Search className="h-8 w-8 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">Search by Topics</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Find papers from your research domains
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => { setSeedMode("skip"); setStep(2); }}
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 hover:border-foreground/30 hover:bg-muted/30 transition-colors"
                >
                  <Sparkles className="h-8 w-8 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">Skip for Now</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Add papers later via upload or import
                    </p>
                  </div>
                </button>
              </div>
            )}

            {/* Author papers (auto-loaded) */}
            {seedMode === "author" && (
              <div className="space-y-4">
                {searching && (
                  <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Fetching your papers...</span>
                  </div>
                )}
                {!searching && seedPapers.length > 0 && (
                  <PaperList
                    papers={seedPapers}
                    onToggle={togglePaper}
                    onToggleAll={toggleAllPapers}
                    selectedCount={selectedCount}
                  />
                )}
                {!searching && seedPapers.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-sm text-muted-foreground">No papers found.</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => { setSeedMode("topics"); setSeedPapers([]); }}
                    >
                      Search by topic instead
                    </Button>
                  </div>
                )}

                {/* Switch to topics */}
                {!searching && seedPapers.length > 0 && (
                  <p className="text-xs text-muted-foreground text-center">
                    Not what you expected?{" "}
                    <button
                      onClick={() => { setSeedMode("topics"); setSeedPapers([]); }}
                      className="underline hover:text-foreground"
                    >
                      Search by topic instead
                    </button>
                  </p>
                )}
              </div>
            )}

            {/* Topic search */}
            {seedMode === "topics" && (
              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-medium">Search topics</Label>
                  <div className="flex gap-2 mt-1.5">
                    <Input
                      value={topicInput}
                      onChange={(e) => setTopicInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && topicInput.trim()) {
                          e.preventDefault();
                          setSearchTopics([...searchTopics, topicInput.trim()]);
                          setTopicInput("");
                        }
                      }}
                      placeholder="e.g. attention mechanisms, RLHF"
                    />
                    <Button
                      onClick={handleTopicSearch}
                      disabled={searching || (searchTopics.length === 0 && domains.length === 0)}
                    >
                      {searching ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="mr-1.5 h-4 w-4" />
                      )}
                      {searching ? "Searching..." : "Search"}
                    </Button>
                  </div>
                  {searchTopics.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {searchTopics.map((t, i) => (
                        <Badge key={i} variant="secondary" className="gap-1 pr-1">
                          {t}
                          <button
                            onClick={() => setSearchTopics(searchTopics.filter((_, j) => j !== i))}
                            className="ml-0.5 hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  {searchTopics.length === 0 && domains.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Press Search to find papers from your domains: {domains.slice(0, 3).join(", ")}
                    </p>
                  )}
                </div>

                {seedPapers.length > 0 && (
                  <PaperList
                    papers={seedPapers}
                    onToggle={togglePaper}
                    onToggleAll={toggleAllPapers}
                    selectedCount={selectedCount}
                  />
                )}
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => { setStep(0); setSeedMode(null); setSeedPapers([]); }}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back
              </Button>
              {(seedMode === "topics" || seedMode === "author") && seedPapers.length > 0 && (
                <Button onClick={importSelected} disabled={importing || selectedCount === 0}>
                  {importing ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="mr-1.5 h-4 w-4" />
                  )}
                  Import {selectedCount} & Continue
                </Button>
              )}
              {seedMode !== null && seedPapers.length === 0 && !searching && (
                <Button variant="ghost" onClick={() => setStep(2)}>
                  Skip
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2: Ready ────────────────────────────────────────── */}
        {step === 2 && (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                <Check className="h-8 w-8 text-emerald-600" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">You&apos;re All Set</h1>
              <p className="text-muted-foreground mt-2 max-w-md mx-auto">
                Arcana will personalize paper reviews based on your profile.
                You can always update your preferences in Settings → Profile.
              </p>
            </div>
            <Button size="lg" onClick={completeOnboarding} disabled={completing}>
              {completing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Start Exploring
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
