'use strict';

// Allow content scripts to access chrome.storage.session.
// Without this, only extension pages (popup, service worker) can use it,
// so the content script's persist/resume flow for multi-month automation
// silently fails.
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});
