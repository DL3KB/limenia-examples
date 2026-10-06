// ---------------------------------------------------------------------------
// AUTH STUB: REPLACE WITH YOUR LOGIN.
//
// This stub trusts the header X-User-Id so that the example runs without a
// login system. Anyone can send that header. Use your real session or token
// check (e.g. verify a JWT) and set req.user = { id } from it.
//
// The user ID you set here is what Limenia sees as reporter, author or
// appellant. It must come from your login, never from the request body.
// Use a stable internal ID, not an e-mail address.
// ---------------------------------------------------------------------------

export function requireUser(req, res, next) {
  if (process.env.NODE_ENV === "production") {
    // Fail closed so the stub can never reach production by accident.
    return res.status(501).json({ code: "auth_not_configured" });
  }
  const id = req.get("X-User-Id");
  if (!id || id.length > 128) {
    return res.status(401).json({ code: "unauthenticated" });
  }
  req.user = { id };
  next();
}
