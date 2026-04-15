import { describe, it, expect } from "vitest";
import { detectCaptions } from "../caption-detector";

describe("detectCaptions", () => {
  it("detects 'Figure N:' pattern", () => {
    const text = "Some text before.\nFigure 3: Architecture of the proposed model.\nMore text after.";
    const captions = detectCaptions(text, 1);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Figure 3");
    expect(captions[0].type).toBe("figure");
    expect(captions[0].captionText).toContain("Architecture");
  });

  it("detects 'Table N:' pattern", () => {
    const text = "\nTable 1: Results on the benchmark dataset.\n";
    const captions = detectCaptions(text, 5);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Table 1");
    expect(captions[0].type).toBe("table");
  });

  it("detects 'Fig. N' pattern", () => {
    const text = "\nFig. 2. Overview of the training pipeline.\n";
    const captions = detectCaptions(text, 3);
    expect(captions).toHaveLength(1);
    expect(captions[0].label).toBe("Fig. 2");
  });

  it("detects subfigure labels", () => {
    const text = "\nFigure 1a: Left panel.\nFigure 1b: Right panel.\n";
    const captions = detectCaptions(text, 2);
    expect(captions).toHaveLength(2);
    expect(captions[0].label).toBe("Figure 1a");
    expect(captions[1].label).toBe("Figure 1b");
  });

  it("returns empty for text without captions", () => {
    const text = "This is regular paragraph text with no figures or tables mentioned as captions.";
    expect(detectCaptions(text, 1)).toHaveLength(0);
  });

  it("does not match inline references", () => {
    const text = "As shown in Figure 3, the model converges quickly.";
    expect(detectCaptions(text, 1)).toHaveLength(0);
  });

  it("handles multiple captions on same page", () => {
    const text = "\nFigure 1: First figure.\nSome text.\nTable 1: First table.\n";
    const captions = detectCaptions(text, 1);
    expect(captions).toHaveLength(2);
    expect(captions[0].type).toBe("figure");
    expect(captions[1].type).toBe("table");
  });
});
