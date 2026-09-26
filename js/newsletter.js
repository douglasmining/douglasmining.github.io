// Newsletter signup: the address is encrypted in this browser to the Douglas
// Mining public key before it leaves the page. The server stores only the
// ciphertext. See worker/README.md.
(() => {
  var API = 'https://douglasmining-newsletter.robert-7ca.workers.dev';

  var form = document.getElementById('newsletter-form');
  var email = document.getElementById('email');
  var button = document.getElementById('newsletter-submit');
  var status = document.getElementById('newsletter-status');
  var unsubToggle = document.getElementById('unsubscribe-toggle');
  var unsubForm = document.getElementById('unsubscribe-form');
  var unsubRef = document.getElementById('unsubscribe-ref');
  var unsubStatus = document.getElementById('unsubscribe-status');
  if (!form) return;

  var keyPromise = null;
  function publicKey() {
    if (!keyPromise) {
      keyPromise = fetch(API + '/key')
        .then(function (r) { if (!r.ok) throw new Error('key'); return r.text(); })
        .then(function (armored) { return openpgp.readKey({ armoredKey: armored }); })
        .catch(function (e) { keyPromise = null; throw e; });
    }
    return keyPromise;
  }

  function say(el, text, kind) {
    el.textContent = text || '';
    el.className = 'newsletter-status' + (kind ? ' is-' + kind : '');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = (email.value || '').trim();
    if (!value) return;
    if (typeof openpgp === 'undefined') {
      say(status, 'Encryption library failed to load. Please refresh and try again.', 'error');
      return;
    }
    button.disabled = true;
    say(status, 'Encrypting…');

    publicKey()
      .then(function (key) {
        return openpgp.createMessage({ text: JSON.stringify({ email: value, at: new Date().toISOString() }) })
          .then(function (message) { return openpgp.encrypt({ message: message, encryptionKeys: key }); });
      })
      .then(function (armored) {
        say(status, 'Sending…');
        return fetch(API + '/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ m: armored }),
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Something went wrong.');
        form.reset();
        say(status, 'Thank you! You are on the list. Your reference code is ' + res.body.ref + ' — keep it if you ever want to unsubscribe.', 'ok');
      })
      .catch(function (err) {
        say(status, err.message === 'key' ? 'Could not reach the signup service. Please try again shortly.' : (err.message || 'Something went wrong.'), 'error');
      })
      .then(function () { button.disabled = false; });
  });

  if (unsubToggle && unsubForm) {
    unsubToggle.addEventListener('click', function (e) {
      e.preventDefault();
      unsubForm.style.display = unsubForm.style.display === 'none' ? 'block' : 'none';
      if (unsubForm.style.display === 'block') unsubRef.focus();
    });
    unsubForm.addEventListener('submit', function (e) {
      e.preventDefault();
      say(unsubStatus, 'One moment…');
      fetch(API + '/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: unsubRef.value }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) throw new Error(j.error);
          say(unsubStatus, j.ok ? 'You have been unsubscribed.' : 'That code was not found, or it was already unsubscribed.', j.ok ? 'ok' : 'error');
          if (j.ok) unsubForm.reset();
        })
        .catch(function (err) { say(unsubStatus, err.message || 'Something went wrong.', 'error'); });
    });
  }
})();
