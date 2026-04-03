// Computed once at module load — the embed param never changes during a session
const _embedded = new URLSearchParams(window.location.search).get('embed') === '1';

export function isEmbedded(): boolean {
  return _embedded;
}
