/**
 * The loading ferret, drawn like the logo: flat bold green, pointed ears, black eye, dark nose. It digs head-down into
 * the severity bars (red / orange / yellow), a front paw scooping and chips of bar flying back. A spinner ring runs
 * around the scene.
 */
export function FerretDigger({ size = 40 }: { size?: number }) {
  return (
    <span className="digger" style={{ width: size, height: size }} aria-label="Reviewing…" role="img">
      <svg viewBox="0 0 44 44" width={size - 4} height={size - 4} aria-hidden="true">
        {/* the bars from the logo, as the ground */}
        <rect x="-6" y="27" width="56" height="5.5" rx="2.75" fill="#ef5b4e" />
        <rect x="-6" y="33" width="56" height="5.5" rx="2.75" fill="#f0923f" />
        <rect x="-6" y="39" width="56" height="5.5" rx="2.75" fill="#eab63b" />
        {/* the ferret (bobs as it digs) */}
        <g className="dig-ferret">
          {/* tail (wags) */}
          <g className="dig-tail">
            <path d="M9.5 21.5 C6 19 3 16.5 1.5 13.5 C4.5 15 8 18 11 20.5 Z" fill="#1f8a47" />
          </g>
          {/* hind leg */}
          <path d="M12 24 L11 30 L15 30 L15.5 24.5 Z" fill="#1f8a47" />
          {/* body: long and low, head end dipping to the hole */}
          <path d="M9 25.5 C7.5 19.5 14 14.5 21.5 15.5 C27 16.2 30.5 19.5 32.5 24.5 L33.5 28 L29 29 C22 28.6 13 28.2 9 25.5 Z" fill="#2fb35c" />
          {/* darker belly line, like the logo's shading */}
          <path d="M10 26 C15 27.8 23 28.2 29.5 28.6 L33.5 28 L29 29 C22 28.6 13 28.2 9 25.5 Z" fill="#1f8a47" />
          {/* head */}
          <path d="M26.5 17.5 C30.5 16.5 34 19 35.5 23.5 C36.5 26 37.5 28 38.5 29.5 L33.5 28.5 C31 26.5 28 24 26.5 21 Z" fill="#2fb35c" />
          {/* ears */}
          <path d="M27 18.5 L25.5 13 L30 16.5 Z" fill="#2fb35c" />
          <path d="M31 17 L31.5 12 L34 16.5 Z" fill="#2fb35c" />
          <path d="M27.5 17.8 L26.6 14.6 L29.3 16.6 Z" fill="#1f8a47" />
          <path d="M31.4 16.6 L31.7 13.6 L33.2 16.3 Z" fill="#1f8a47" />
          {/* eye + nose */}
          <circle cx="32.6" cy="21.6" r="1.25" fill="#101010" />
          <circle cx="33" cy="21.2" r="0.4" fill="#ffffff" />
          <circle cx="38.3" cy="29.3" r="1.1" fill="#101010" />
          {/* front paw (scoops) */}
          <g className="dig-leg">
            <path d="M30 26 C31.5 27.5 32.5 29.5 33 31.5 L29.5 31.8 C29 29.8 28.8 28 29 26.5 Z" fill="#1f8a47" />
          </g>
        </g>
        {/* the hole in the bars, over the snout */}
        <ellipse cx="36" cy="31.5" rx="5.5" ry="2.2" fill="#1e1e1e" />
        {/* chips of the bars kicked out of the hole, flying high over the ferret's back (drawn on top) */}
        <g className="dig-dirt">
          <circle className="d1" cx="34" cy="29" r="2.2" fill="#ef5b4e" />
          <circle className="d2" cx="35" cy="30" r="1.7" fill="#f0923f" />
          <circle className="d3" cx="33" cy="30" r="1.4" fill="#eab63b" />
          <circle className="d4" cx="36" cy="29" r="1.2" fill="#ef5b4e" />
        </g>
      </svg>
    </span>
  );
}
