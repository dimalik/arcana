"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Sparkles,
  FlaskConical,
  Search,
  BarChart3,
  Compass,
  FileText,
  X,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

const DOMAINS = [
  "Machine Learning", "NLP", "Computer Vision", "Reinforcement Learning",
  "Neuroscience", "Pharmacology", "Statistics", "Physics",
  "Biology", "Economics", "Social Science", "HCI",
];

const METHODOLOGIES = [
  {
    id: "experimental",
    label: "Experimental",
    icon: FlaskConical,
    description: "Hypothesis testing with controlled experiments",
    emphasis: "Heavy on hypothesis + experiment phases",
  },
  {
    id: "analytical",
    label: "Analytical / Survey",
    icon: Search,
    description: "Systematic review of existing literature",
    emphasis: "Heavy on literature + analysis phases",
  },
  {
    id: "design_science",
    label: "Design Science",
    icon: BarChart3,
    description: "Build and evaluate an artifact or system",
    emphasis: "Heavy on experiment + reflection phases",
  },
  {
    id: "exploratory",
    label: "Exploratory",
    icon: Compass,
    description: "Open-ended investigation of a topic",
    emphasis: "Balanced across all phases",
  },
];

interface PaperOption {
  id: string;
  title: string;
}

export function CreationWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [creating, setCreating] = useState(false);
  const [refining, setRefining] = useState(false);

  // Step 1
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [subQuestions, setSubQuestions] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);

  // Step 2
  const [methodology, setMethodology] = useState<string | null>(null);

  // Step 3
  const [seedPapers, setSeedPapers] = useState<PaperOption[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PaperOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [arXivUrl, setArXivUrl] = useState("");

  const toggleDomain = (d: string) => {
    setSelectedDomains((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  };

  const handleRefine = async () => {
    if (!question.trim()) return;
    setRefining(true);
    try {
      const res = await fetch("/api/research/new/refine-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, domains: selectedDomains }),
      });
      if (!res.ok) throw new Error("Failed to refine");
      const data = await res.json();
      if (data.refinedQuestion) setQuestion(data.refinedQuestion);
      if (data.subQuestions) setSubQuestions(data.subQuestions);
      if (data.keywords) setKeywords(data.keywords);
      if (data.methodology && !methodology) setMethodology(data.methodology);
      toast.success("Brief refined");
    } catch {
      toast.error("Failed to refine question");
    } finally {
      setRefining(false);
    }
  };

  const searchPapers = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/papers?search=${encodeURIComponent(searchQuery)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        const papers = (Array.isArray(data) ? data : data.papers || []) as PaperOption[];
        setSearchResults(papers.filter((p) => !seedPapers.some((s) => s.id === p.id)));
      }
    } catch {
      toast.error("Failed to search papers");
    } finally {
      setSearching(false);
    }
  };

  const addPaper = (paper: PaperOption) => {
    setSeedPapers((prev) => [...prev, paper]);
    setSearchResults((prev) => prev.filter((p) => p.id !== paper.id));
  };

  const removePaper = (id: string) => {
    setSeedPapers((prev) => prev.filter((p) => p.id !== id));
  };

  const handleCreate = async () => {
    if (!title.trim() || !question.trim()) {
      toast.error("Title and question are required");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          question: question.trim(),
          subQuestions,
          domains: selectedDomains,
          keywords,
          methodology,
          seedPaperIds: seedPapers.map((p) => p.id),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
      const project = await res.json();
      toast.success("Research project created");
      router.push(`/research/${project.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => (step > 1 ? setStep(step - 1) : router.push("/research"))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-sm font-medium">New Research Project</h1>
          <p className="text-xs text-muted-foreground">Step {step} of 3</p>
        </div>
      </div>

      {/* Progress */}
      <div className="flex gap-1.5">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              s <= step ? "bg-primary" : "bg-muted"
            }`}
          />
        ))}
      </div>

      {/* Step 1: Research Question */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Project Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Efficient Attention Mechanisms in LLMs"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Research Question
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What is the question you want to investigate?"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
            <button
              onClick={handleRefine}
              disabled={!question.trim() || refining}
              className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            >
              {refining ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Help me refine
            </button>
          </div>

          {subQuestions.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Sub-Questions
              </label>
              <div className="space-y-1">
                {subQuestions.map((q, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-muted-foreground/50 mt-0.5">{i + 1}.</span>
                    <span>{q}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {keywords.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Keywords
              </label>
              <div className="flex flex-wrap gap-1.5">
                {keywords.map((k) => (
                  <span key={k} className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px]">
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Domains
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDomain(d)}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                    selectedDomains.includes(d)
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Methodology */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Choose a methodology that best fits your research. This adjusts which phases are emphasized.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {METHODOLOGIES.map((m) => {
              const Icon = m.icon;
              const selected = methodology === m.id;
              return (
                <Card
                  key={m.id}
                  className={`cursor-pointer transition-colors ${
                    selected ? "border-primary bg-primary/5" : "hover:border-foreground/20"
                  }`}
                  onClick={() => setMethodology(m.id)}
                >
                  <CardContent className="py-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${selected ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-sm font-medium">{m.label}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{m.description}</p>
                    <p className="text-[11px] text-muted-foreground/70">{m.emphasis}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3: Seed Papers */}
      {step === 3 && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Optionally add seed papers from your library. These anchor the literature review.
          </p>

          {/* Search library */}
          <div className="flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchPapers()}
              placeholder="Search your library..."
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={searchPapers}
              disabled={searching || !searchQuery.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs hover:bg-accent transition-colors disabled:opacity-50"
            >
              {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              Search
            </button>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="rounded-md border border-border divide-y divide-border">
              {searchResults.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs truncate flex-1 mr-2">{p.title}</span>
                  <button
                    onClick={() => addPaper(p)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Selected papers */}
          {seedPapers.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Selected Papers ({seedPapers.length})
              </label>
              <div className="space-y-1">
                {seedPapers.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                    <FileText className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                    <span className="text-xs flex-1 truncate">{p.title}</span>
                    <button
                      onClick={() => removePaper(p.id)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ArXiv import */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Or paste arXiv / DOI link
            </label>
            <input
              value={arXivUrl}
              onChange={(e) => setArXivUrl(e.target.value)}
              placeholder="https://arxiv.org/abs/..."
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <button
          onClick={() => (step > 1 ? setStep(step - 1) : router.push("/research"))}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          {step > 1 ? "Back" : "Cancel"}
        </button>

        {step < 3 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={step === 1 && (!title.trim() || !question.trim())}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-xs hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            Next
            <ArrowRight className="h-3 w-3" />
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating || !title.trim() || !question.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-1.5 text-xs hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
            Create Project
          </button>
        )}
      </div>
    </div>
  );
}
