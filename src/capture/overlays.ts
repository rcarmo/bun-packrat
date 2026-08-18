/** Script evaluated in the captured page to remove common browser overlays. */
export const DISMISS_OVERLAYS_JS = `
(function() {
  const remove = new Set();
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const textLength = (el.textContent || '').trim().length;
    const isPositionedOverlay =
      (s.position === 'fixed' || s.position === 'sticky') &&
      Number(s.zIndex || 0) > 100 &&
      rect.width * rect.height > viewportArea * 0.04;
    if (isPositionedOverlay && textLength < 4000) remove.add(el);
  });
  // Only remove known controls when they are small enough to be chrome rather
  // than page content. Never match broad terms such as "newsletter": Substack
  // uses newsletter-post on the article itself.
  ['cookie', 'consent', 'gdpr', 'subscribe-widget', 'signup-widget', 'popup', 'modal', 'paywall', 'fc-dialog']
    .forEach(kw => {
      document.querySelectorAll(\`[class*="\${kw}" i],[id*="\${kw}" i]\`).forEach(el => {
        if ((el.textContent || '').trim().length < 4000) remove.add(el);
      });
    });
  remove.forEach(el => el.remove());
})();
`;
