// The petrel: drawn once across the page when the inbox is clear, then gone. Off in Settings, and still when the
// system asks for less motion (styles.css).

export default function Petrel() {
  return (
    <svg class="petrel-glide" width="460" height="120" viewBox="0 0 460 120" fill="none" aria-hidden="true">
      <path class="petrel-trail" d="M10 100 C 120 30, 240 110, 450 30" stroke="var(--accent-soft)" stroke-width="1.5" stroke-dasharray="3 6" />
      <g class="petrel-bird">
        <path d="M0 14c8-2 12-12 20-12-3 4-3 8 0 12 6-6 12-8 20-6-8 2-12 8-18 14" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      </g>
    </svg>
  );
}
