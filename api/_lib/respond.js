/** JSON response helper. Every API response carries customer data, so it is never cacheable. */
export function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
