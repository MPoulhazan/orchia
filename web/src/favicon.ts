/** What the tab icon signals: nothing, a session blocked on the user, a plan limit at 90% or more, or a finished session not looked at yet. */
export type FaviconBadge = 'none' | 'waiting' | 'limit' | 'done';

const BADGE_COLOR: Record<Exclude<FaviconBadge, 'none'>, string> = { waiting: '#ffe24d', limit: '#f07b72', done: '#8da2ff' };

/** A dark tile with the 2×2 grid mark, one cell lit; a dot in the corner when something wants attention. */
function faviconSvg(badge: FaviconBadge): string {
  const cell = (x: number, y: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="9" height="9" rx="2" fill="${fill}"/>`;
  const dot =
    badge === 'none'
      ? ''
      : `<circle cx="25" cy="7" r="6.5" fill="${BADGE_COLOR[badge]}" stroke="#111418" stroke-width="2.5"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#111418"/>` +
    cell(5, 5, '#4fc58e') +
    cell(18, 5, '#9aa3ae') +
    cell(5, 18, '#9aa3ae') +
    cell(18, 18, '#9aa3ae') +
    dot +
    `</svg>`
  );
}

function faviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

export function setFavicon(badge: FaviconBadge) {
  const link = faviconLink();
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(badge))}`;
}

let drawing = 0;

/**
 * The tab icon for the project on screen: its own icon, with the same attention dot on top.
 * Falls back to Orchia's mark when the project has no icon or it cannot be drawn.
 */
export function setProjectFavicon(badge: FaviconBadge, iconUrl: string | undefined) {
  const turn = ++drawing;
  if (!iconUrl) return setFavicon(badge);
  const img = new Image();
  img.onload = () => {
    if (turn !== drawing) return;
    try {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return setFavicon(badge);
      ctx.drawImage(img, 0, 0, size, size);
      if (badge !== 'none') {
        ctx.beginPath();
        ctx.arc(50, 14, 13, 0, Math.PI * 2);
        ctx.fillStyle = BADGE_COLOR[badge];
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#111418';
        ctx.stroke();
      }
      const link = faviconLink();
      link.type = 'image/png';
      link.href = canvas.toDataURL('image/png');
    } catch {
      setFavicon(badge);
    }
  };
  img.onerror = () => {
    if (turn === drawing) setFavicon(badge);
  };
  img.src = iconUrl;
}
