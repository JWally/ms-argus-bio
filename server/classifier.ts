// server/classifier.ts
// kNN classification logic using Qdrant nearest neighbor results

import type { VectorSearchResult } from "./qdrant-client";
import type { Label } from "./types";

const K = 10;
const SCORE_THRESHOLD = 0.7;

export interface ClassifyResult {
  verdict: Label;
  confidence: number;
  neighborCount: number;
}

/**
 * Classify a submission using kNN weighted voting.
 *
 * Query Qdrant for K=10 nearest neighbors (cosine, threshold 0.7).
 * Count weighted votes by label. Return:
 * - humanScore >= 0.7 → verdict human
 * - humanScore <= 0.3 → verdict bot
 * - Otherwise → uncertain
 * - Cold start (no neighbors) → fall back to heuristic label
 */
export function classify(
  neighbors: VectorSearchResult[],
  heuristicFallback: Label,
): ClassifyResult {
  // Filter to neighbors above score threshold
  const qualified = neighbors
    .filter((n) => n.score >= SCORE_THRESHOLD)
    .slice(0, K);

  // Cold start: no neighbors → use heuristic
  if (qualified.length === 0) {
    return {
      verdict: heuristicFallback,
      confidence: heuristicFallback === "uncertain" ? 0.5 : 0.6,
      neighborCount: 0,
    };
  }

  // Weighted voting by similarity score
  let humanWeight = 0;
  let botWeight = 0;
  let totalWeight = 0;

  for (const neighbor of qualified) {
    const label = neighbor.payload?.label as string | undefined;
    const weight = neighbor.score;
    totalWeight += weight;
    if (label === "human") humanWeight += weight;
    else if (label === "bot") botWeight += weight;
    // "uncertain" neighbors don't vote
  }

  // If no labeled neighbors voted, fall back to heuristic
  if (humanWeight + botWeight === 0) {
    return {
      verdict: heuristicFallback,
      confidence: 0.5,
      neighborCount: qualified.length,
    };
  }

  const humanScore = humanWeight / (humanWeight + botWeight);

  let verdict: Label;
  let confidence: number;

  if (humanScore >= 0.7) {
    verdict = "human";
    confidence = humanScore;
  } else if (humanScore <= 0.3) {
    verdict = "bot";
    confidence = 1 - humanScore;
  } else {
    verdict = "uncertain";
    confidence = 1 - Math.abs(humanScore - 0.5) * 2; // peaks at 0.5
  }

  return { verdict, confidence, neighborCount: qualified.length };
}

export { K, SCORE_THRESHOLD };
