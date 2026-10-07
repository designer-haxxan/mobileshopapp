// Login link helper: opening  <app>/#u=<username>&p=<password>  (values encodeURIComponent-encoded) fills the login form.
// The credentials live in the URL fragment, so they are never sent to a server. They are removed from the address bar
// after filling, are not stored anywhere, and the form is NOT submitted — the user taps Login. Runs before the router (js/app.js).
(function prefillLogin() {
  if (!location.hash) return;
  var hashPart = location.hash.substring(1);
  var params = new URLSearchParams(hashPart);
  var u = params.get('u'), p = params.get('p');
  if (u === null || p === null) return;
  params = null;

  var tries = 0;
  function fill() {
    var user = document.getElementById('login-username'),
        pass = document.getElementById('login-password'),
        view = document.getElementById('view-login');

    // Wait for form to exist and be visible
    if (!user || !pass || !view || view.classList.contains('d-none')) {
      if (++tries < 100) {
        setTimeout(fill, 100);
        return;
      }
      u = p = null; // Timeout
      return;
    }

    // Fill the form
    user.value = u;
    pass.value = p;
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    u = p = null;

    // Remove credentials from URL now that they're in the form
    history.replaceState(null, '', location.pathname + location.search);

    // Show hint and highlight button
    var hint = document.getElementById('prefill-hint'),
        btn = document.getElementById('login-btn'),
        form = document.getElementById('login-form');

    if (hint) hint.classList.remove('d-none');
    if (btn) btn.classList.add('btn-attention');
    if (form) form.addEventListener('submit', function clearStatus() {
      if (hint) hint.classList.add('d-none');
      if (btn) btn.classList.remove('btn-attention');
    }, { once: true });
  }

  // Run immediately if DOM is ready, otherwise wait
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fill, { once: true });
  } else {
    fill();
  }
})();
