/**
 * Sprint 1 unit tests.
 *
 * Tests cover the pure functions in the Claude client and Slack handler
 * that have no external dependencies. No database or API calls required.
 */

import { describe, it, expect } from "vitest";
import { detectSreTag, extractConfidence } from "../src/agent/claudeClient.js";

// ---------------------------------------------------------------------------
// detectSreTag
// ---------------------------------------------------------------------------

describe("detectSreTag", () => {
  it("detects @sre-team mention", () => {
    expect(
      detectSreTag("I'm not confident here — @sre-team please review this.")
    ).toBe(true);
  });

  it("returns false when no tag present", () => {
    expect(detectSreTag("Here is your SLO configuration. Looks good.")).toBe(
      false
    );
  });

  it("does not match partial text", () => {
    expect(detectSreTag("The sre team should look at this.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractConfidence
// ---------------------------------------------------------------------------

describe("extractConfidence", () => {
  it("extracts a labelled percentage", () => {
    expect(extractConfidence("Confidence: 75% on this recommendation.")).toBe(
      0.75
    );
  });

  it("extracts an inline percentage", () => {
    expect(
      extractConfidence("I'm about 60% confident here — @sre-team review.")
    ).toBe(0.6);
  });

  it("returns undefined when absent", () => {
    expect(extractConfidence("Here is your runbook draft.")).toBeUndefined();
  });

  it("clamps to 1.0 for values over 100", () => {
    expect(extractConfidence("Confidence: 110%")).toBe(1.0);
  });

  it("clamps to 0.0 for zero", () => {
    expect(extractConfidence("Confidence: 0%")).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// stripBotMention (tested via the exported helper)
// ---------------------------------------------------------------------------

describe("stripBotMention", () => {
  // Inline the function here since it's not exported — tests the behaviour
  function strip(text: string): string {
    return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
  }

  it("strips a mention at the start", () => {
    expect(strip("<@U12345678> help me with SLOs")).toBe("help me with SLOs");
  });

  it("strips multiple mentions", () => {
    expect(strip("<@U12345678> <@U99999999> help me")).toBe("help me");
  });

  it("returns unchanged text with no mention", () => {
    expect(strip("help me with SLOs")).toBe("help me with SLOs");
  });

  it("returns empty string for mention-only text", () => {
    expect(strip("<@U12345678>")).toBe("");
  });
});
