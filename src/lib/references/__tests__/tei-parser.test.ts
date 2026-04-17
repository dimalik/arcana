import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseGrobidTeiReferences } from "../grobid/tei-parser";

const sampleTei = readFileSync(
  new URL("./recorded/grobid-processReferences-sample.xml", import.meta.url),
  "utf-8",
);

describe("parseGrobidTeiReferences", () => {
  it("parses structured bibliography entries from TEI", () => {
    const refs = parseGrobidTeiReferences(sampleTei);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      referenceIndex: 1,
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: 2017,
      venue: "Advances in Neural Information Processing Systems",
      doi: "10.5555/3295222.3295349",
      extractionMethod: "grobid_tei",
    });
    expect(refs[0].rawCitation).toContain("Attention Is All You Need");

    expect(refs[1]).toMatchObject({
      referenceIndex: 2,
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      authors: ["Jacob Devlin"],
      year: 2019,
      venue: "NAACL",
      arxivId: "1810.04805",
    });
  });

  it("falls back when raw_reference is missing", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TEI xmlns="http://www.tei-c.org/ns/1.0">
        <text>
          <back>
            <div type="references">
              <listBibl>
                <biblStruct>
                  <analytic>
                    <title level="a">A Study on Parsing</title>
                    <author><persName><forename>Jane</forename><surname>Doe</surname></persName></author>
                  </analytic>
                  <monogr>
                    <title level="m">ACL</title>
                    <imprint><date when="2020-01-01" /></imprint>
                  </monogr>
                </biblStruct>
              </listBibl>
            </div>
          </back>
        </text>
      </TEI>`;

    const refs = parseGrobidTeiReferences(xml);
    expect(refs).toHaveLength(1);
    expect(refs[0].rawCitation).toContain("Jane Doe");
    expect(refs[0].rawCitation).toContain("A Study on Parsing");
    expect(refs[0].year).toBe(2020);
  });

  it("cleans year-prefixed titles and avoids venue duplication", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TEI xmlns="http://www.tei-c.org/ns/1.0">
        <text>
          <back>
            <div type="references">
              <listBibl>
                <biblStruct>
                  <analytic>
                    <title level="a">2024a. Fighting fire with fire: Can chatgpt detect ai-generated text?</title>
                    <author><persName><forename>A</forename><surname>Bhattacharjee</surname></persName></author>
                    <author><persName><forename>H</forename><surname>Liu</surname></persName></author>
                  </analytic>
                  <monogr>
                    <title level="j">SIGKDD Explorations Newsletter</title>
                  </monogr>
                  <note type="raw_reference">A. Bhattacharjee and H. Liu. 2024a. Fighting fire with fire: Can chatgpt detect ai-generated text? In SIGKDD Explorations Newsletter, volume 25, pages 1-12.</note>
                </biblStruct>
              </listBibl>
            </div>
          </back>
        </text>
      </TEI>`;

    const refs = parseGrobidTeiReferences(xml);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      title: "Fighting fire with fire: Can chatgpt detect ai-generated text?",
      venue: "SIGKDD Explorations Newsletter",
      authors: ["A Bhattacharjee", "H Liu"],
    });
  });

  it("uses raw citation recovery for suspicious titles and cleans arxiv ids", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TEI xmlns="http://www.tei-c.org/ns/1.0">
        <text>
          <back>
            <div type="references">
              <listBibl>
                <biblStruct>
                  <analytic>
                    <title level="a">Abhimanyu Hans, Avi Schwarzschild, Valeriia Cherepanova, Hamid Kazemi, Aniruddha Saha, Micah Goldblum, Jonas Geiping, and Tom Goldstein. 2024. Spotting LLMs with Binoculars: Zero-shot detection of machine-generated text.</title>
                    <idno type="arXiv">arXiv:2401.12070 [cs.CL]</idno>
                  </analytic>
                  <note type="raw_reference">Abhimanyu Hans, Avi Schwarzschild, Valeriia Cherepanova, Hamid Kazemi, Aniruddha Saha, Micah Goldblum, Jonas Geiping, and Tom Goldstein. 2024. Spotting LLMs with Binoculars: Zero-shot de- tection of machine-generated text. arXiv:2401.12070 [cs.CL].</note>
                </biblStruct>
              </listBibl>
            </div>
          </back>
        </text>
      </TEI>`;

    const refs = parseGrobidTeiReferences(xml);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      title: "Spotting LLMs with Binoculars: Zero-shot detection of machine-generated text",
      arxivId: "2401.12070",
      venue: null,
      year: 2024,
    });
  });

  it("strips author-list pollution from titles and prefers the trailing publication year", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <TEI xmlns="http://www.tei-c.org/ns/1.0">
        <text>
          <back>
            <div type="references">
              <listBibl>
                <biblStruct>
                  <analytic>
                    <title level="a">Aviya Skowron, Lintang Sutawika, and Oskar van der Wal. Pythia: A suite for analyzing large language models across training and scaling.</title>
                    <author><persName><forename>Stella</forename><surname>Biderman</surname></persName></author>
                    <author><persName><forename>Hailey</forename><surname>Schoelkopf</surname></persName></author>
                  </analytic>
                  <monogr>
                    <title level="m">Advances in Neural Information Processing Systems</title>
                    <imprint><biblScope unit="page">1877-1901</biblScope><date>2020</date></imprint>
                  </monogr>
                  <note type="raw_reference">Tom Brown, Benjamin Mann, Nick Ryder, et al. Language Models are Few-Shot Learners. Advances in Neural Information Processing Systems, 33:1877-1901, 2020.</note>
                </biblStruct>
              </listBibl>
            </div>
          </back>
        </text>
      </TEI>`;

    const refs = parseGrobidTeiReferences(xml);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      title: "Pythia: A suite for analyzing large language models across training and scaling",
      year: 2020,
      venue: "Advances in Neural Information Processing Systems",
    });
  });
});
