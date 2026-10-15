class BugReelModal extends HTMLElement {}

if (typeof customElements !== 'undefined' && !customElements.get('bugreel-modal')) {
  customElements.define('bugreel-modal', BugReelModal);
}

export { BugReelModal };
