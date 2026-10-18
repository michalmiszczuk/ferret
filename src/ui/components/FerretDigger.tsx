/** The loading ferret: head in the hole, rump up, tail wagging, dirt flying. A spinner ring runs around the scene. */
export function FerretDigger({ size = 40 }: { size?: number }) {
  return (
    <span className="digger" style={{ width: size, height: size }} aria-label="Reviewing…" role="img">
      <svg viewBox="0 0 44 44" width={size - 8} height={size - 8} aria-hidden="true">
        {/* dirt kicked out of the hole */}
        <g className="dig-dirt">
          <circle className="d1" cx="27" cy="30" r="1.4" />
          <circle className="d2" cx="29" cy="31" r="1.1" />
          <circle className="d3" cx="26" cy="31" r="0.9" />
        </g>
        {/* the ferret (bobs as it digs) */}
        <g className="dig-ferret">
          {/* tail (wags) */}
          <g className="dig-tail">
            <path d="M14 26 Q6 22 3 25 Q7 28 14 29 Z" fill="#53402e" />
          </g>
          {/* rump + back sloping into the hole */}
          <path d="M11 34 Q10 24 18 22 Q26 20 30 27 L32 34 Z" fill="#dcb787" />
          {/* sable saddle */}
          <path d="M13 27 Q14 22.5 19 22 Q25 21.5 29 26 Q24 24 19 25 Q15 25.5 13 27 Z" fill="#8a6b49" />
          {/* hind leg */}
          <rect x="14.5" y="30" width="4" height="6.5" rx="2" fill="#53402e" />
        </g>
        {/* mound + hole (drawn over the head) */}
        <path d="M24 36 Q31 30 41 35 L41 39 Q32 41 24 39 Z" fill="#4e4337" />
        <ellipse cx="32" cy="35" rx="6.5" ry="2.4" fill="#241e19" />
        {/* ground line */}
        <path d="M3 38 Q22 36 41 38 L41 41 L3 41 Z" fill="#3a332b" />
      </svg>
    </span>
  );
}
