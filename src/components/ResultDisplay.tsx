function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

interface DigitResult {
  target: number;
  recognized: number;
  confidence: number;
  timeMs: number;
}

interface ResultDisplayProps {
  challenge: number[];
  digits: DigitResult[];
  totalTimeMs: number;
  timedOut: boolean;
}

export default function ResultDisplay({
  challenge,
  digits,
  totalTimeMs,
  timedOut,
}: ResultDisplayProps) {
  const passed = !timedOut;

  return (
    <div className={`result-panel ${passed ? 'result-pass' : 'result-fail'}`}>
      <div className="result-header">{passed ? 'VERIFIED' : 'TIMEOUT'}</div>
      <div className="result-time">{formatTime(totalTimeMs)}</div>

      <div className="result-digits">
        {challenge.map((d, i) => {
          const dr = digits[i];
          return (
            <div key={i} className="result-digit-row">
              <span className="result-digit-target">{d}</span>
              {dr ? (
                <>
                  <span className="result-digit-conf">
                    {Math.round(dr.confidence * 100)}%
                  </span>
                  <span className="result-digit-time">
                    {(dr.timeMs / 1000).toFixed(2)}s
                  </span>
                </>
              ) : (
                <span className="result-digit-miss">--</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
