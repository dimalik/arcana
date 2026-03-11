"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Save,
  Loader2,
  User,
  Mail,
  Shield,
  Plus,
  X,
  Check,
  GraduationCap,
  Building,
  FlaskConical,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";

const ROLES = [
  { value: "phd_student", label: "PhD Student", icon: GraduationCap },
  { value: "postdoc", label: "Postdoc", icon: FlaskConical },
  { value: "professor", label: "Professor", icon: BookOpen },
  { value: "industry_researcher", label: "Industry", icon: Building },
  { value: "engineer", label: "Engineer", icon: Building },
  { value: "student", label: "Student", icon: GraduationCap },
] as const;

const EXPERTISE_LEVELS = [
  { value: "beginner", label: "Getting started" },
  { value: "intermediate", label: "Comfortable" },
  { value: "expert", label: "Expert" },
] as const;

const REVIEW_FOCUSES = [
  { value: "methodology", label: "Methodology" },
  { value: "novelty", label: "Novelty" },
  { value: "applications", label: "Applications" },
  { value: "reproducibility", label: "Reproducibility" },
  { value: "theoretical_rigor", label: "Theoretical Rigor" },
  { value: "clinical_relevance", label: "Clinical Relevance" },
] as const;

export default function ProfilePage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [researchRole, setResearchRole] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [expertiseLevel, setExpertiseLevel] = useState("");
  const [reviewFocus, setReviewFocus] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setName(data.name || "");
          setEmail(data.email || "");
          setRole(data.role || "member");
          setResearchRole(data.researchRole || "");
          setAffiliation(data.affiliation || "");
          setDomains(data.domains || []);
          setExpertiseLevel(data.expertiseLevel || "");
          setReviewFocus(data.reviewFocus || []);
          setLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

  const addDomain = (d: string) => {
    const clean = d.trim().toLowerCase().replace(/\s+/g, "-");
    if (clean && !domains.includes(clean)) {
      setDomains([...domains, clean]);
    }
    setDomainInput("");
  };

  const toggleFocus = (f: string) => {
    setReviewFocus((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          researchRole: researchRole || null,
          affiliation: affiliation.trim() || null,
          domains,
          expertiseLevel: expertiseLevel || null,
          reviewFocus,
        }),
      });
      if (res.ok) {
        toast.success("Profile updated");
      } else {
        toast.error("Failed to update profile");
      }
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  const initials = name
    ? name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : email?.[0]?.toUpperCase() ?? "U";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Profile</h2>
        <p className="text-muted-foreground">
          Manage your account and research preferences
        </p>
      </div>

      {/* Account */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-xl font-semibold text-muted-foreground">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-lg font-medium truncate">{name || email}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{email}</span>
              </div>
            </div>
            <Badge variant="outline" className="capitalize flex items-center gap-1">
              <Shield className="h-3 w-3" />
              {role}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="profile-name">
                <User className="inline h-3.5 w-3.5 mr-1" />
                Display Name
              </Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={email} disabled className="text-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Research Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Research Profile</CardTitle>
          <p className="text-sm text-muted-foreground">
            Used to personalize paper reviews and summaries
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Role */}
          <div>
            <Label className="text-sm font-medium">Research role</Label>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              {ROLES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setResearchRole(researchRole === value ? "" : value)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
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
              onChange={(e) => setAffiliation(e.target.value)}
              placeholder="MIT, Google Research, etc."
              className="mt-1.5"
            />
          </div>

          {/* Domains */}
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
                    <button
                      onClick={() => setDomains(domains.filter((x) => x !== d))}
                      className="ml-0.5 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Expertise */}
          <div>
            <Label className="text-sm font-medium">Expertise level</Label>
            <div className="flex gap-2 mt-1.5">
              {EXPERTISE_LEVELS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setExpertiseLevel(expertiseLevel === value ? "" : value)}
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    expertiseLevel === value
                      ? "border-foreground bg-foreground/5 font-medium"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  {expertiseLevel === value && <Check className="inline h-3 w-3 mr-1" />}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Review focus */}
          <div>
            <Label className="text-sm font-medium">Review focus areas</Label>
            <div className="flex flex-wrap gap-2 mt-1.5">
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
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          )}
          Save changes
        </Button>
      </div>
    </div>
  );
}
