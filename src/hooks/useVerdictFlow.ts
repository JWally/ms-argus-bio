import { useState, useCallback } from 'react';
import type { CanvasHandle, Stroke } from '../components/DrawingCanvas';
import {
  computeFeatures,
  detectTampering,
  detectCDP,
  type DigitResult,
  type ConfidenceSnapshot,
  type VerdictResult,
} from '../utils/biometrics';
import { runTripwire, type TripwireResult } from '../vm/tripwire';
import { measureAsync, measureSync } from '../utils/perf';
import { workerEncrypt } from '../utils/crypto-worker-client';
import { isEmbedded } from '../utils/embed';
import type { Glyph } from './useChallenge';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const MSG_ERROR = 'argus-bio-error';
const MEASURE_BIOMETRICS = 'compute:biometrics';

export interface UseVerdictFlowParams {
  allStrokesRef: React.MutableRefObject<Stroke[]>;
  digitResultsRef: React.MutableRefObject<DigitResult[]>;
  confidenceTimelineRef: React.MutableRefObject<ConfidenceSnapshot[]>;
  canvasRef: React.RefObject<CanvasHandle | null>;
  challengeRef: React.MutableRefObject<Glyph[]>;
  challengeIdRef: React.MutableRefObject<string>;
  rawPublicKeyRef: React.MutableRefObject<string>;
  serverPubKeyRef: React.MutableRefObject<string>;
  sessionIdRef: React.MutableRefObject<string | null>;
}

export interface UseVerdictFlowResult {
  verdict: VerdictResult | null;
  argusToken: string | null;
  returnUrl: string | null;
  retryMsg: string | null;
  /** Build and send the biometric payload. Call when the user completes the challenge. */
  submitPayload: (totalTimeMs: number, timedOut: boolean) => void;
  /** Clear all verdict state (call on reset). */
  reset: () => void;
}

export function useVerdictFlow({
  allStrokesRef,
  digitResultsRef,
  confidenceTimelineRef,
  canvasRef,
  challengeRef,
  challengeIdRef,
  rawPublicKeyRef,
  serverPubKeyRef,
  sessionIdRef,
}: UseVerdictFlowParams): UseVerdictFlowResult {
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [argusToken, setArgusToken] = useState<string | null>(null);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  const submitPayload = useCallback(
    (totalTimeMs: number, timedOut: boolean) => {
      const features = measureSync(MEASURE_BIOMETRICS, () =>
        computeFeatures(allStrokesRef.current)
      );
      const tamperedApis = measureSync('detect:tampering', () => [
        ...detectTampering(),
        ...detectCDP(),
      ]);

      const payload = {
        challengeId: challengeIdRef.current || crypto.randomUUID(),
        // Don't leak expected answers — just send glyph count (all letters)
        challenge: challengeRef.current.map(() => 1),
        timestamp: Date.now(),
        completionTimeMs: totalTimeMs,
        passed: !timedOut,
        digits: digitResultsRef.current,
        confidenceTimeline: confidenceTimelineRef.current,
        inputType: canvasRef.current?.getInputType() ?? 'unknown',
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
        userAgent: navigator.userAgent,
        features,
        tamperedApis,
        vmHash: '' as string,
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
      };

      // Run tripwire VM with payload + serverPubKey for pristine ECDH encryption.
      // The bridge modifies `payload` in-place (sets vmHash, immolates if tampered).
      const tripwirePromise = measureAsync('vm:tripwire', () =>
        runTripwire(
          allStrokesRef.current,
          features,
          payload as Record<string, unknown>,
          serverPubKeyRef.current || undefined
        )
      ).catch(
        (): TripwireResult => ({
          tampered: false,
          vmSignals: [],
          vmIntegrityHash: '',
        })
      );

      // eslint-disable-next-line no-console
      void tripwirePromise.then(() => console.log('[ARGUS BIO] Biometric Payload', payload));

      const fallbackVerdict: VerdictResult = { verdict: 'uncertain' };

      if (!API_URL) {
        setVerdict(fallbackVerdict);
        return;
      }

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10_000);

      // Wait for tripwire to complete before sending
      tripwirePromise.then((tw) => {
        performance.mark('fetch:classify:start');
        let sendRequest: Promise<Response>;

        if (tw.encrypted && tw.publicKeyB64) {
          // Use pristine VM crypto — bot hooks on crypto.subtle never see this
          sendRequest = fetch(`${API_URL}/v1/classify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Canvas-Fp': tw.publicKeyB64,
            },
            body: tw.encrypted.buffer as ArrayBuffer,
            signal: ctrl.signal,
          });
        } else {
          // Fallback: worker encrypt or plain JSON
          const canEncrypt = rawPublicKeyRef.current && serverPubKeyRef.current;
          sendRequest = canEncrypt
            ? workerEncrypt(payload, serverPubKeyRef.current).then((encrypted) =>
                fetch(`${API_URL}/v1/classify`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Canvas-Fp': rawPublicKeyRef.current,
                  },
                  body: encrypted.buffer as ArrayBuffer,
                  signal: ctrl.signal,
                })
              )
            : fetch(`${API_URL}/v1/classify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
              });
        }

        sendRequest
          .then((res) => res.json())
          .then((v) => {
            // eslint-disable-next-line no-console
            console.log('[ARGUS BIO] Verdict', v);
            if (v.error) {
              // eslint-disable-next-line no-console
              console.error('[ARGUS BIO] Server error:', v.error);
              if (isEmbedded()) {
                window.parent.postMessage({ type: MSG_ERROR, error: v.error }, '*');
              }
              setRetryMsg(v.error);
              return;
            }
            if (v.retry) {
              setRetryMsg(v.message || 'Incorrect. Try again!');
              return;
            }
            const result = v as VerdictResult;
            setVerdict(result);
            if (result.token) setArgusToken(result.token);
            if (result.returnUrl) setReturnUrl(result.returnUrl);
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[ARGUS BIO] Classification error', err);
            setVerdict(fallbackVerdict);
            if (isEmbedded()) {
              setTimeout(() => {
                window.parent.postMessage(
                  { type: MSG_ERROR, error: 'Verification error. Please try again.' },
                  '*'
                );
              }, 2000);
            }
          })
          .finally(() => {
            performance.mark('fetch:classify:end');
            performance.measure('fetch:classify', 'fetch:classify:start', 'fetch:classify:end');
            clearTimeout(timeout);
          });
      });
    },
    // Refs are stable — no dependency churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const reset = useCallback(() => {
    setVerdict(null);
    setArgusToken(null);
    setReturnUrl(null);
    setRetryMsg(null);
  }, []);

  return { verdict, argusToken, returnUrl, retryMsg, submitPayload, reset };
}
