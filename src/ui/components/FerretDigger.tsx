/** The loading ferret: head in the hole, rump up, tail wagging, dirt flying. A spinner ring runs around the scene. */
export function FerretDigger({ size = 40 }: { size?: number }) {
  return (
    <span className="digger" style={{ width: size, height: size }} aria-label="Reviewing…" role="img">
      {/* viewBox is shifted so the ferret's body (the bright mass) sits in the middle of the circle. */}
      <svg viewBox="-4 7 44 44" width={size - 4} height={size - 4} aria-hidden="true">
        {/* dirt kicked out of the hole, spilling back over the ferret */}
        <g className="dig-dirt">
          <circle className="d1" cx="28" cy="30" r="2" />
          <circle className="d2" cx="30" cy="31" r="1.5" />
          <circle className="d3" cx="27" cy="31" r="1.2" />
          <circle className="d4" cx="29" cy="30" r="1" />
        </g>
        {/* the ferret (bobs as it digs) */}
        <g className="dig-ferret">
          {/* tail: bushy, dark-tipped (wags) */}
          <g className="dig-tail">
            <path d="M12.5 26 C8.5 23.4 4.6 22.8 2.2 24.4 C3.6 27.4 8 29.2 12.8 29.4 C11.9 28.3 11.9 27.1 12.5 26 Z" fill="#4a351f" />
            <path d="M6.5 24.1 C4.8 23.9 3.3 24 2.2 24.4 C2.9 25.9 4.3 27.1 6.2 28 C5.6 26.7 5.7 25.3 6.5 24.1 Z" fill="#32230f" />
          </g>
          {/* far hind leg, half behind the body */}
          <path d="M20.5 30 L20 35.6 L23 35.6 L23.4 30.5 Z" fill="#43301c" />
          {/* body: arched back diving into the hole */}
          <path
            d="M11.5 33 C10.4 27.2 12.6 21.6 18 20.3 C23.2 19.1 27.8 22 30.2 26.6 C31.2 28.7 31.8 31.3 32.2 33.8 C28 34.8 14.5 34.7 11.5 33 Z"
            fill="#ecc795"
            stroke="#201609"
            strokeWidth="0.7"
          />
          {/* sable saddle along the spine */}
          <path d="M12.6 26.2 C14 21.8 19 19.7 23.6 20.7 C26.7 21.4 29.2 23.8 30.6 27 C27 24.3 23.9 23.4 20.4 23.8 C16.7 24.2 14.3 25.1 12.6 26.2 Z" fill="#7d5a39" />
          {/* round haunch */}
          <circle cx="17.3" cy="28.6" r="4.7" fill="#f3dcb2" />
          {/* near hind leg + foot (kicks) */}
          <g className="dig-leg">
            <path d="M15 28.8 C13.9 31.4 14 33.8 14.8 35.8 L18.4 35.8 C18 33.5 18.3 31.4 19.2 29.4 Z" fill="#5a4028" />
            <ellipse cx="16.4" cy="36" rx="2.8" ry="1.2" fill="#32230f" />
          </g>
        </g>
        {/* mound + hole (drawn over the head) */}
        <path d="M24 36 Q31 30 41 35 L41 39 Q32 41 24 39 Z" fill="#5a4b38" />
        <ellipse cx="32" cy="35" rx="6.5" ry="2.4" fill="#17110c" />
        {/* ground line (wide enough to span the circle after the viewBox shift) */}
        <path d="M-12 38 Q22 35.5 52 38 L52 51 L-12 51 Z" fill="#453c31" />
      </svg>
    </span>
  );
}
