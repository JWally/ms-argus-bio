import { describe, it, expect } from 'vitest';
import { classify, K, SCORE_THRESHOLD } from './classifier';
import type { VectorSearchResult } from './qdrant-client';

function neighbor(label: string, score: number): VectorSearchResult {
  return { id: crypto.randomUUID(), score, payload: { label } };
}

describe('classify', () => {
  describe('cold start (no qualified neighbors)', () => {
    it('falls back to heuristic when neighbors list is empty', () => {
      const result = classify([], 'human');
      expect(result.verdict).toBe('human');
      expect(result.confidence).toBe(0.6);
      expect(result.neighborCount).toBe(0);
    });

    it('uses 0.5 confidence when heuristic fallback is uncertain', () => {
      const result = classify([], 'uncertain');
      expect(result.confidence).toBe(0.5);
    });

    it('filters out neighbors below the score threshold', () => {
      const lowScoreNeighbors = [neighbor('human', 0.3), neighbor('bot', 0.5)];
      const result = classify(lowScoreNeighbors, 'bot');
      expect(result.verdict).toBe('bot');
      expect(result.neighborCount).toBe(0);
    });
  });

  describe('weighted voting', () => {
    it('returns human when humanScore >= 0.7', () => {
      const neighbors = [
        neighbor('human', 0.95),
        neighbor('human', 0.9),
        neighbor('human', 0.85),
        neighbor('bot', 0.75),
      ];
      const result = classify(neighbors, 'uncertain');
      expect(result.verdict).toBe('human');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result.neighborCount).toBe(4);
    });

    it('returns bot when humanScore <= 0.3', () => {
      const neighbors = [
        neighbor('bot', 0.95),
        neighbor('bot', 0.9),
        neighbor('bot', 0.85),
        neighbor('human', 0.72),
      ];
      const result = classify(neighbors, 'uncertain');
      expect(result.verdict).toBe('bot');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('returns uncertain when vote is split', () => {
      const neighbors = [
        neighbor('human', 0.9),
        neighbor('bot', 0.88),
        neighbor('human', 0.85),
        neighbor('bot', 0.82),
      ];
      const result = classify(neighbors, 'uncertain');
      expect(result.verdict).toBe('uncertain');
    });

    it('ignores uncertain-labeled neighbors in the vote', () => {
      const neighbors = [
        neighbor('human', 0.95),
        neighbor('uncertain', 0.92),
        neighbor('uncertain', 0.9),
      ];
      // With heuristic='uncertain', kNN human vote wins (no veto)
      const result = classify(neighbors, 'uncertain');
      expect(result.verdict).toBe('human');
      expect(result.neighborCount).toBe(3);
    });

    it('heuristic bot veto overrides kNN human verdict', () => {
      const neighbors = [
        neighbor('human', 0.95),
        neighbor('uncertain', 0.92),
        neighbor('uncertain', 0.9),
      ];
      // With heuristic='bot', kNN human vote is vetoed
      const result = classify(neighbors, 'bot');
      expect(result.verdict).toBe('bot');
      expect(result.confidence).toBe(0.8);
      expect(result.neighborCount).toBe(3);
    });

    it('falls back to heuristic when all neighbors are uncertain-labeled', () => {
      const neighbors = [neighbor('uncertain', 0.95), neighbor('uncertain', 0.9)];
      const result = classify(neighbors, 'bot');
      expect(result.verdict).toBe('bot');
      expect(result.confidence).toBe(0.5);
      expect(result.neighborCount).toBe(2);
    });

    it('weights higher-similarity neighbors more heavily', () => {
      // One strong human signal vs many weak bot signals
      const neighbors = [neighbor('human', 0.99), neighbor('bot', 0.71), neighbor('bot', 0.71)];
      const result = classify(neighbors, 'uncertain');
      // human weight = 0.99, bot weight = 1.42, humanScore = 0.99/2.41 ≈ 0.41
      expect(result.verdict).toBe('uncertain');
    });

    it('limits to K neighbors', () => {
      // More than K neighbors above threshold — only first K should count
      const neighbors = Array.from({ length: K + 5 }, (_, i) => neighbor('human', 0.95 - i * 0.01));
      const result = classify(neighbors, 'uncertain');
      expect(result.neighborCount).toBe(K);
    });
  });

  it('exports expected constants', () => {
    expect(K).toBe(10);
    expect(SCORE_THRESHOLD).toBe(0.7);
  });
});
