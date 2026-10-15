// ---------------------------------------------------------------------------
// AUTH PLACEHOLDER: REPLACE WITH YOUR LOGIN.
//
// Use your real session or token check (e.g. verify a JWT) and set
// req.user = { id } from it. The ID is what Limenia sees as reporter, author or
// appellant. It must be the stable internal ID of the signed-in user (not an
// e-mail address) and must come from your login, never from the request body.
//
// The X-User-Id header below is a fallback for local testing only. It is
// enabled only by LIMENIA_EXAMPLE_INSECURE_DEV_AUTH=1, and anyone can send that
// header. Never set the variable in a deployed environment. Without it, every
// route that uses requireUser answers 401 auth_not_configured.
// ---------------------------------------------------------------------------

export const insecureDevAuth = () => process.env.LIMENIA_EXAMPLE_INSECURE_DEV_AUTH === "1";

export function requireUser(req, res, next) {
  if (!insecureDevAuth()) {
    return reject(res, "auth_not_configured", "No login configured: replace the auth placeholder with your own login.");
  }
  const id = req.get("X-User-Id");
  if (!id || id.length > 128) {
    return reject(res, "unauthenticated", "Not signed in.");
  }
  req.user = { id };
  next();
}

function reject(res, code, detail) {
  res.status(401).type("application/problem+json").send(JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401, code, detail }));
}
