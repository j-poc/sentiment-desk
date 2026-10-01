import { describe, expect, it } from "vitest";
import { FirstEvidenceRecovery, shouldRefreshDeskOnFirstEvidence } from "../web/src/lib/firstRunEvidence.js";

describe("first saved evidence refresh", () => {
  it("refreshes company and feed snapshots when evidence arrives after an empty check", () => {
    expect(shouldRefreshDeskOnFirstEvidence(0, 1, false)).toBe(true);
  });

  it("does not repeat the recovery refresh for each new record", () => {
    expect(shouldRefreshDeskOnFirstEvidence(1, 2, true)).toBe(false);
  });

  it("refreshes an initially positive result only if the company snapshot has not caught up", () => {
    expect(shouldRefreshDeskOnFirstEvidence(null, 1, false)).toBe(true);
    expect(shouldRefreshDeskOnFirstEvidence(null, 1, true)).toBe(false);
  });

  it("does not refresh while the verified history is empty", () => {
    expect(shouldRefreshDeskOnFirstEvidence(null, 0, false)).toBe(false);
    expect(shouldRefreshDeskOnFirstEvidence(0, 0, false)).toBe(false);
  });
});

describe("first evidence snapshot recovery", () => {
  it("retries a failed company read on the next history poll without refreshing feeds again", () => {
    const recovery = new FirstEvidenceRecovery();
    expect(recovery.observe(0, false)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: true, refreshSnapshot: true });
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    recovery.snapshotSettled();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    expect(recovery.observe(13, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });

  it("recovers an initially positive history when the initial company snapshot failed", () => {
    const recovery = new FirstEvidenceRecovery();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: true, refreshSnapshot: true });
    recovery.snapshotSettled();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
  });

  it("keeps recovery pending after a stale successful snapshot and retries only on the next history poll", () => {
    const recovery = new FirstEvidenceRecovery();
    expect(recovery.observe(0, false)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: true, refreshSnapshot: true });
    recovery.snapshotApplied(false);
    recovery.snapshotSettled();

    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });

  it("retries after a failed read followed by a stale successful snapshot, then clears on caught-up data", () => {
    const recovery = new FirstEvidenceRecovery();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: true, refreshSnapshot: true });
    recovery.snapshotFailed();
    recovery.snapshotSettled();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
    recovery.snapshotApplied(false);
    recovery.snapshotSettled();

    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });

  it("accepts a successful overlapping snapshot and stops pending retries", () => {
    const recovery = new FirstEvidenceRecovery();
    recovery.observe(0, false);
    recovery.observe(12, false);
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });

  it("does not recover history that is empty or already visible", () => {
    const recovery = new FirstEvidenceRecovery();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    expect(recovery.observe(13, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    const empty = new FirstEvidenceRecovery();
    empty.observe(1, false);
    empty.snapshotSettled();
    expect(empty.observe(0, false)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });

  it("recovers a later failed snapshot after successful history without another feed refresh", () => {
    const recovery = new FirstEvidenceRecovery();
    recovery.observe(12, false);
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    recovery.snapshotFailed();
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: true });
    expect(recovery.observe(12, false)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
    recovery.snapshotApplied(true);
    recovery.snapshotSettled();
    expect(recovery.observe(12, true)).toEqual({ refreshFeeds: false, refreshSnapshot: false });
  });
});
