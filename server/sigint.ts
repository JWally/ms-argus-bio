// server/sigint.ts
// Redeem sigint probe tokens from DynamoDB and score bot signals.
//
// The client fires tcp-probe + h2-probe during ECDH encryption (bridge.ts 0x32),
// using a pristine fetch reference captured before any bot can patch window.fetch.
// Tokens travel inside the AES-256-GCM encrypted payload.
// Here we redeem them and score the resulting TLS/H2/network fingerprints.

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});
const PROBE_TOKENS_TABLE = process.env.PROBE_TOKENS_TABLE;

// ── Fingerprint types (mirrors Go structs in ms-argus-sigint) ────────────────

interface TlsSignals {
  has_grease: boolean;
  cipher_count: number;
  ua_mismatch: boolean;
  ua_hints?: string[];
}

interface ClientHints {
  ua?: string;
  ua_mobile?: string;
  ua_platform?: string;
}

interface TcpProbeFingerprint {
  ja4?: string;
  tls_signals?: TlsSignals;
  client_hints?: ClientHints | null;
  client_ip: string;
}

interface H2ProbeFingerprint {
  fingerprint: string;
  pseudo_header_order?: string;
  header_order?: string[];
  ja4?: string;
  tls_signals?: TlsSignals;
  user_agent?: string;
  client_ip: string;
}

// ── DynamoDB redemption ──────────────────────────────────────────────────────

async function redeemToken(token: string): Promise<{ fp: string; clientIp: string } | null> {
  if (!PROBE_TOKENS_TABLE || !token) return null;
  try {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: PROBE_TOKENS_TABLE,
        Key: { token: { S: token } },
        ProjectionExpression: 'fingerprint, client_ip',
      })
    );
    if (!result.Item?.fingerprint?.S) return null;
    return {
      fp: result.Item.fingerprint.S,
      clientIp: result.Item.client_ip?.S ?? '',
    };
  } catch {
    return null;
  }
}

// ── Scoring helpers ──────────────────────────────────────────────────────────

export interface ProbeScore {
  score: number;
  signals: string[];
}

function scoreTlsSignals(
  tlsSigs: TlsSignals | undefined,
  claimsChrome: boolean,
  claimsFirefox: boolean,
  out: ProbeScore
): void {
  if (!tlsSigs) {
    out.score += 20;
    out.signals.push('no_tls_signals');
    return;
  }
  // GREASE: only Chromium-based browsers send it (RFC 8701)
  if (!tlsSigs.has_grease && claimsChrome) {
    out.score += 40;
    out.signals.push('chrome_ua_no_grease');
  }
  if (tlsSigs.has_grease && claimsFirefox) {
    out.score += 30;
    out.signals.push('firefox_ua_has_grease');
  }
  if (tlsSigs.ua_mismatch) {
    out.score += 30;
    out.signals.push('tls_ua_mismatch');
    for (const h of tlsSigs.ua_hints ?? []) out.signals.push(`hint:${h}`);
  }
}

function scoreClientHints(
  tcpFp: TcpProbeFingerprint | null,
  claimsChrome: boolean,
  out: ProbeScore
): void {
  // Chrome always sends Sec-CH-UA when the probe issues Accept-CH.
  // Firefox and Safari don't, so only penalise Chrome UAs.
  if (claimsChrome && tcpFp && !tcpFp.client_hints) {
    out.score += 25;
    out.signals.push('chrome_ua_no_client_hints');
  }
}

function scoreJa4CipherCount(ja4: string | undefined, out: ProbeScore): void {
  if (!ja4) return;
  // JA4: t13d{ciphers:02}{exts:02}{alpn}_hashB_hashC
  // Node.js TLS typically presents 12-15 ciphers with no GREASE padding.
  const nCiphers = parseInt((ja4.split('_')[0] ?? '').substring(4, 6), 10);
  if (!isNaN(nCiphers) && nCiphers < 12) {
    out.score += 35;
    out.signals.push(`low_cipher_count:${nCiphers}`);
  }
}

function scoreIpConsistency(probeIp: string, classifyIp: string, out: ProbeScore): void {
  // The probe token is bound to the IP that hit the sigint probe.
  // A mismatch means the bot split-routed: probe via residential proxy, classify direct.
  if (!probeIp || !classifyIp) return;
  const pIp = probeIp.split(':')[0];
  const cIp = classifyIp.split(':')[0];
  if (pIp !== cIp) {
    out.score += 35;
    out.signals.push(`ip_mismatch:probe=${pIp},classify=${cIp}`);
  }
}

// ── Parsed probe data ────────────────────────────────────────────────────────

interface ParsedProbes {
  tcpFp: TcpProbeFingerprint | null;
  tlsSigs: TlsSignals | undefined;
  ja4: string | undefined;
  probeClientIp: string;
}

function parseProbeRows(
  tcpRow: { fp: string; clientIp: string } | null,
  h2Row: { fp: string; clientIp: string } | null
): ParsedProbes {
  const tcpFp = tcpRow ? (JSON.parse(tcpRow.fp) as TcpProbeFingerprint) : null;
  const h2Fp = h2Row ? (JSON.parse(h2Row.fp) as H2ProbeFingerprint) : null;
  const clientIp = h2Row ? h2Row.clientIp : tcpRow ? tcpRow.clientIp : '';
  return {
    tcpFp,
    tlsSigs: h2Fp ? h2Fp.tls_signals : tcpFp ? tcpFp.tls_signals : undefined,
    ja4: h2Fp ? h2Fp.ja4 : tcpFp ? tcpFp.ja4 : undefined,
    probeClientIp: clientIp.split(':')[0],
  };
}

function parseUaFlags(userAgent: string): { claimsChrome: boolean; claimsFirefox: boolean } {
  const ua = userAgent.toLowerCase();
  return {
    claimsChrome: /chrome\//.test(ua) && !/chromium\//.test(ua) && !/edg\//.test(ua),
    claimsFirefox: /firefox\//.test(ua),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Score threshold above which we treat the request as a bot. */
export const PROBE_BOT_THRESHOLD = 50;

/**
 * Redeem tcpProbeToken + h2ProbeToken from DynamoDB and compute a bot score.
 * Score >= PROBE_BOT_THRESHOLD → treat as bot.
 * Missing tokens are themselves a risk signal.
 */
export async function redeemAndScore(opts: {
  tcpToken: string | undefined;
  h2Token: string | undefined;
  userAgent: string;
  classifyClientIp: string;
}): Promise<ProbeScore> {
  const { tcpToken, h2Token, userAgent, classifyClientIp } = opts;
  const out: ProbeScore = { score: 0, signals: [] };

  const [tcpRow, h2Row] = await Promise.all([
    tcpToken ? redeemToken(tcpToken) : Promise.resolve(null),
    h2Token ? redeemToken(h2Token) : Promise.resolve(null),
  ]);

  if (!tcpRow && !h2Row) {
    out.score += 30;
    out.signals.push('no_probe_tokens');
    return out;
  }

  const { tcpFp, tlsSigs, ja4, probeClientIp } = parseProbeRows(tcpRow, h2Row);
  const { claimsChrome, claimsFirefox } = parseUaFlags(userAgent);

  scoreTlsSignals(tlsSigs, claimsChrome, claimsFirefox, out);
  scoreClientHints(tcpFp, claimsChrome, out);
  scoreJa4CipherCount(ja4, out);
  scoreIpConsistency(probeClientIp, classifyClientIp, out);

  return out;
}
