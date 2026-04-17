import { describe, expect, it } from "vitest";

import { capabilitySubstrateInternals } from "../capability-substrate";

function makePaperInput(overrides: Partial<Parameters<typeof capabilitySubstrateInternals.buildCapabilityInputsHash>[0]> = {}) {
  return {
    id: "paper-1",
    doi: null,
    arxivId: null,
    sourceUrl: null,
    ...overrides,
  };
}

describe("capability substrate helpers", () => {
  it("derives stable capability hashes from paper identity inputs", () => {
    const first = capabilitySubstrateInternals.buildCapabilityInputsHash(
      makePaperInput({ doi: "10.1000/example", arxivId: "1234.5678" }),
    );
    const second = capabilitySubstrateInternals.buildCapabilityInputsHash(
      makePaperInput({ doi: "10.1000/example", arxivId: "1234.5678" }),
    );
    const different = capabilitySubstrateInternals.buildCapabilityInputsHash(
      makePaperInput({ doi: "10.1000/other", arxivId: "1234.5678" }),
    );

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it("marks structured sources usable only when their required identifiers exist", () => {
    const paper = makePaperInput({ doi: "10.1000/example", arxivId: "1234.5678" });

    expect(capabilitySubstrateInternals.evaluateSourceCapability("pmc_jats", paper)).toMatchObject({
      status: "usable",
      reasonCode: "doi_present",
    });
    expect(capabilitySubstrateInternals.evaluateSourceCapability("publisher_html", paper)).toMatchObject({
      status: "usable",
      reasonCode: "doi_present",
    });
    expect(capabilitySubstrateInternals.evaluateSourceCapability("arxiv_html", paper)).toMatchObject({
      status: "usable",
      reasonCode: "arxiv_id_present",
    });
  });

  it("derives rollout coverage class from the strongest structured sources", () => {
    expect(capabilitySubstrateInternals.derivePaperCoverageClass([
      { source: "pmc_jats", status: "usable" },
      { source: "arxiv_html", status: "usable" },
      { source: "publisher_html", status: "usable" },
    ])).toBe("both");

    expect(capabilitySubstrateInternals.derivePaperCoverageClass([
      { source: "pmc_jats", status: "usable" },
      { source: "arxiv_html", status: "unusable" },
      { source: "publisher_html", status: "usable" },
    ])).toBe("pmc_usable");

    expect(capabilitySubstrateInternals.derivePaperCoverageClass([
      { source: "pmc_jats", status: "unusable" },
      { source: "arxiv_html", status: "usable" },
      { source: "publisher_html", status: "unusable" },
    ])).toBe("arxiv_usable");

    expect(capabilitySubstrateInternals.derivePaperCoverageClass([
      { source: "pmc_jats", status: "unusable" },
      { source: "arxiv_html", status: "unusable" },
      { source: "publisher_html", status: "usable" },
    ])).toBe("publisher_html_usable");

    expect(capabilitySubstrateInternals.derivePaperCoverageClass([
      { source: "pmc_jats", status: "unusable" },
      { source: "arxiv_html", status: "unusable" },
      { source: "publisher_html", status: "unusable" },
    ])).toBe("structured_none");
  });

  it("builds snapshot hashes from coverage class and concrete evaluation ids", () => {
    const first = capabilitySubstrateInternals.buildSnapshotInputsHash("both", [
      {
        id: "eval-1",
        source: "pmc_jats",
        status: "usable",
        reasonCode: "doi_present",
        inputsHash: "hash-1",
      },
      {
        id: "eval-2",
        source: "arxiv_html",
        status: "usable",
        reasonCode: "arxiv_id_present",
        inputsHash: "hash-2",
      },
    ]);
    const second = capabilitySubstrateInternals.buildSnapshotInputsHash("both", [
      {
        id: "eval-1",
        source: "pmc_jats",
        status: "usable",
        reasonCode: "doi_present",
        inputsHash: "hash-1",
      },
      {
        id: "eval-2",
        source: "arxiv_html",
        status: "usable",
        reasonCode: "arxiv_id_present",
        inputsHash: "hash-2",
      },
    ]);
    const changed = capabilitySubstrateInternals.buildSnapshotInputsHash("pmc_usable", [
      {
        id: "eval-1",
        source: "pmc_jats",
        status: "usable",
        reasonCode: "doi_present",
        inputsHash: "hash-1",
      },
    ]);

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });
});

