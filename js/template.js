// Email template helpers: "Copy template" puts the outline on the clipboard;
// "Open in email" is a mailto: link with the subject and body prefilled.
(() => {
  var src = document.getElementById('email-template');
  var row = document.querySelector('.template-actions');
  if (!src || !row) return;
  var to = src.getAttribute('data-to') || '';
  var subject = src.getAttribute('data-subject') || '';
  var body = src.textContent.replace(/^\n+|\s+$/g, '');
  var copyBtn = row.querySelector('.template-copy');
  var mailLink = row.querySelector('.template-mail');
  var status = row.querySelector('.template-status');

  if (mailLink) {
    mailLink.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function say(text, isError) {
    if (!status) return;
    status.textContent = text;
    status.className = 'template-status' + (isError ? ' is-error' : '');
    clearTimeout(say.t);
    say.t = setTimeout(function () { status.textContent = ''; }, 2500);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var text = 'To: ' + to + '\nSubject: ' + subject + '\n\n' + body;
      var done = function (ok) {
        say(ok ? 'Copied. Paste it into a new email.' : 'Copy failed. Select the text above and copy it.', !ok);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { done(true); },
          function () { done(fallbackCopy(text)); }
        );
      } else {
        done(fallbackCopy(text));
      }
    });
  }
})();
