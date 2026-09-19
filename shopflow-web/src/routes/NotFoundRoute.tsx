/**
 * Client-side fallback for a path outside the four legacy routes. The legacy application answered
 * an unknown page with the body text `Not found`, which is kept verbatim.
 */
export function NotFoundRoute() {
  return <p>Not found</p>;
}
