// The public landing page has no React: one message, if sign-in sent the
// visitor back with ?error=.
const MESSAGES: Record<string, string> = {
  access: 'Your account does not have access to this tool yet. You can ask for it from your account page.',
  signin: 'Signing in did not finish. Please try again.',
  provider: 'The sign-in service is not answering right now. Please try again in a moment.',
  unconfigured: 'Sign-in is not configured on this instance.',
};

export function showLandingError() {
  const code = new URLSearchParams(location.search).get('error');
  const box = document.getElementById('error');
  if (!code || !box) return;
  box.textContent = MESSAGES[code] ?? MESSAGES.signin;
  box.hidden = false;
}
