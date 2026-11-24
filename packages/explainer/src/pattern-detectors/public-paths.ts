/**
 * Paths that are public by design: authentication flows (login, signup,
 * password reset, email verification, SSO/SAML/OIDC callbacks), links that
 * carry their own token (invitations, unsubscribe), webhooks and health checks.
 * A route here having no auth is expected — detectors report it as INFO, not
 * as a gap.
 */
export const PUBLIC_BY_DESIGN_PATH =
  /(^|\/)(login|logout|signin|sign-in|signup|sign-up|register|registration|password|passwords|forgot|reset|verify|verification|confirm|otp|2fa|two-factor|mfa|oauth|sso|saml2?|oidc|acs|sls|callback|webhooks?|hooks?|precheck|invitations?|invite|unsubscribe|health|healthz|ping|status|manifest(\.json)?|robots\.txt|sitemap(\.xml)?)(\/|$|[-_.])/i

export function isPublicByDesign(path: string | undefined): boolean {
  return PUBLIC_BY_DESIGN_PATH.test(path ?? "")
}
