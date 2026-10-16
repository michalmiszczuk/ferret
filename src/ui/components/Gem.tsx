import type { Severity } from "../../shared/schema";

/** RPG-style hexagon gem in the severity color (replaces the round emoji dots). */
export function Gem({ severity, size = 12 }: { severity: Severity; size?: number }) {
  return (
    <svg
      className={`gem sev-${severity}`}
      width={size * (12 / 14)}
      height={size}
      viewBox="0 0 12 14"
      aria-hidden="true"
    >
      {/* body */}
      <polygon points="6,0.5 11.5,3.75 11.5,10.25 6,13.5 0.5,10.25 0.5,3.75" fill="var(--sev)" />
      {/* lit top facet + darker bottom facet give the cut-gem look */}
      <polygon points="6,0.5 11.5,3.75 6,6.5 0.5,3.75" fill="#fff" opacity="0.35" />
      <polygon points="0.5,10.25 6,13.5 11.5,10.25 6,7.5" fill="#000" opacity="0.22" />
      <polygon
        points="6,0.5 11.5,3.75 11.5,10.25 6,13.5 0.5,10.25 0.5,3.75"
        fill="none"
        stroke="#000"
        strokeOpacity="0.35"
        strokeWidth="0.8"
      />
    </svg>
  );
}
