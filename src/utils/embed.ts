export function isEmbedded(): boolean {
  return new URLSearchParams(window.location.search).get('embed') === '1';
}
