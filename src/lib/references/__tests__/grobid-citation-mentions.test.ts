import { describe, expect, it } from "vitest";

import { parseGrobidTeiCitationMentions } from "../grobid/citation-mentions";

const SAMPLE_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <body>
      <div>
        <head n="1">Introduction</head>
        <p>
          Scaling laws were established by
          <ref type="bibr" target="#b1">Kaplan et al. (2020)</ref>;
          <ref type="bibr" target="#b2">Hoffmann et al. (2022)</ref>.
        </p>
        <div>
          <head n="1.1">Prior Work</head>
          <p>
            Skip/SmartBERT added trainable gates for cheaper inference
            <ref type="bibr" target="#b4">Chen et al. (2023)</ref>.
          </p>
          <p>
            Hash citations may appear as
            <ref type="bibr">1457c0d6bfcb4967418bfb8ac142f64a-Abstract</ref>.
          </p>
        </div>
      </div>
      <listBibl>
        <biblStruct xml:id="b1" />
        <biblStruct xml:id="b2" />
        <biblStruct xml:id="b3" />
        <biblStruct xml:id="b4" />
      </listBibl>
    </body>
  </text>
</TEI>`;

describe("parseGrobidTeiCitationMentions", () => {
  it("extracts citation mentions with section labels and reference indices", () => {
    const mentions = parseGrobidTeiCitationMentions(SAMPLE_TEI);

    expect(mentions).toEqual([
      {
        citationText: "Kaplan et al. (2020)",
        excerpt:
          "Scaling laws were established by Kaplan et al. (2020); Hoffmann et al. (2022).",
        sectionLabel: "1 Introduction",
        referenceIndex: 1,
      },
      {
        citationText: "Hoffmann et al. (2022)",
        excerpt:
          "Scaling laws were established by Kaplan et al. (2020); Hoffmann et al. (2022).",
        sectionLabel: "1 Introduction",
        referenceIndex: 2,
      },
      {
        citationText: "Chen et al. (2023)",
        excerpt:
          "Skip/SmartBERT added trainable gates for cheaper inference Chen et al. (2023).",
        sectionLabel: "1.1 Prior Work",
        referenceIndex: 4,
      },
      {
        citationText: "1457c0d6bfcb4967418bfb8ac142f64a-Abstract",
        excerpt:
          "Hash citations may appear as 1457c0d6bfcb4967418bfb8ac142f64a-Abstract.",
        sectionLabel: "1.1 Prior Work",
      },
    ]);
  });
});
